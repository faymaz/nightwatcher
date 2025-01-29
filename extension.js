'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Gst from 'gi://Gst';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const TREND_ARROWS = {
    NONE: '→',
    DoubleUp: '↑↑',
    SingleUp: '↑',
    FortyFiveUp: '↗',
    Flat: '→',
    FortyFiveDown: '↘',
    SingleDown: '↓',
    DoubleDown: '↓↓',
    'NOT COMPUTABLE': '?',
    'RATE OUT OF RANGE': '⚠️'
};

const DELTA_THRESHOLDS = {
    VERY_FAST_RISE: 3,
    FAST_RISE: 2,
    MODERATE_RISE: 1,
    SLOW_RISE: 0.5,
    SLOW_FALL: -0.5,
    MODERATE_FALL: -1,
    FAST_FALL: -2,
    VERY_FAST_FALL: -3
};

const ALERT_SOUND_FILE = 'sounds/alert.mp3';
const UPDATE_INTERVAL = 60; // 60 seconds
const ERROR_TEXT = '⚠️ Error';
const LOADING_TEXT = '---';

const NightscoutIndicator = GObject.registerClass(
    class NightscoutIndicator extends PanelMenu.Button {
        _init(settings, extension) {
            super._init(0.0, 'Nightscout Monitor');
            
            this._settings = settings;
            this._extension = extension;
            this._lastReading = null;
            this._timeout = null;
            this._isDestroyed = false;
            this._elements = new Map();
            this._lastAlertTime = 0;
    
            // Create UI
            this._createUI();
    
            // Connect to settings changes after UI is created
            this._settingsChangedId = this._settings.connect('changed', () => {
                if (!this._isDestroyed) {
                    this._updateDisplay();
                }
            });
            
            // Start monitoring with a slight delay
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._isDestroyed) {
                    this._startMonitoring();
                }
                return GLib.SOURCE_REMOVE;
            });
        }

    _updateDisplay() {
        if (this._isDestroyed) return;
    
        // Update UI based on current settings
        const showIcon = this._settings.get_boolean('show-icon');
        const icon = this._elements.get('icon');
        if (icon) {
            icon.visible = showIcon;
        }
    
        if (this._lastReading) {
            this._updatePanelText(this._lastReading);
        }
    }

    _updatePanelText(reading) {
        if (this._isDestroyed) return;
    
        const glucoseLabel = this._elements.get('glucoseLabel');
        const secondaryInfo = this._elements.get('secondaryInfo');
    
        if (!glucoseLabel || !secondaryInfo) {
            console.error('Required UI elements not found');
            return;
        }
    
        // Update main glucose value
        glucoseLabel.set_text(`${reading.sgv}`);
        glucoseLabel.set_style(`color: ${this._getColorForGlucose(reading.sgv)};`);
    
        // Build secondary info text
        let secondaryText = '';
    
        // Add trend and delta if we have previous readings
        if (this._lastReading) {
            // Add trend arrow
            const trend = this._calculateTrendArrow([reading, this._lastReading]);
            secondaryText += trend;
    
            // Add delta
            const delta = this._calculateDelta([reading, this._lastReading]);
            if (delta !== '0.0') {
                const deltaNum = parseFloat(delta);
                secondaryText += ` ${deltaNum > 0 ? '+' : ''}${deltaNum}`;
            }
        }
    
        // Add time
        if (reading.dateString) {
            const now = new Date();
            const readingTime = new Date(reading.dateString);
            const minutesDiff = Math.floor((now - readingTime) / (1000 * 60));
            secondaryText += ` ${minutesDiff}m`;
        }
    
        // Update secondary info
        secondaryInfo.set_text(secondaryText);
    }

    _updateMenuDisplay(reading) {
        if (this._isDestroyed) return;
    
        try {
            const menuItem = this._elements.get('menuItem');
            const deltaItem = this._elements.get('deltaItem');
            const trendItem = this._elements.get('trendItem');
            const elapsedTimeItem = this._elements.get('elapsedTimeItem');
    
            // Update last reading
            if (menuItem && menuItem.label) {
                menuItem.label.set_text(`Last reading: ${reading.sgv} mg/dL`);
            }
    
            // Update delta with correct sign
            if (deltaItem && deltaItem.label) {
                const delta = reading.delta || reading.calculatedDelta;
                if (typeof delta === 'number') {
                    const sign = delta > 0 ? '+' : '';
                    deltaItem.label.set_text(`Delta: ${sign}${delta} mg/dL`);
                } else {
                    deltaItem.label.set_text('Delta: --');
                }
            }
    
            // Update trend
            if (trendItem && trendItem.label) {
                const trend = reading.direction || reading.calculatedTrend;
                trendItem.label.set_text(`Trend: ${trend || '→'}`);
            }
    
            // Update time
            if (elapsedTimeItem && elapsedTimeItem.label && reading.dateString) {
                const now = new Date();
                const readingTime = new Date(reading.dateString);
                const minutesDiff = Math.floor((now - readingTime) / (1000 * 60));
                elapsedTimeItem.label.set_text(`Time: ${minutesDiff}m ago`);
            }
    
        } catch (error) {
            console.error('Error updating menu display:', error);
        }
    }

    _checkAndAlert(sgv) {
        if (!this._settings.get_boolean('enable-alerts')) {
            return;
        }
    
        const now = Date.now();
        const alertInterval = this._settings.get_int('alert-interval') * 1000;
        
        // Check if enough time has passed since the last alert
        if (now - this._lastAlertTime < alertInterval) {
            return;
        }
    
        const urgentHighThreshold = this._settings.get_int('urgent-high-threshold');
        const urgentLowThreshold = this._settings.get_int('urgent-low-threshold');
        
        let shouldAlert = false;
    
        if (this._settings.get_boolean('alert-urgent-high') && sgv >= urgentHighThreshold) {
            shouldAlert = true;
        }
    
        if (this._settings.get_boolean('alert-urgent-low') && sgv <= urgentLowThreshold) {
            shouldAlert = true;
        }
    
        if (shouldAlert) {
            this._playAlert();
            this._lastAlertTime = now;
        }
    }

    async _updateGlucose() {
        if (this._isDestroyed) return;
    
        try {
            const nsUrl = this._settings.get_string('nightscout-url');
            const nsToken = this._settings.get_string('nightscout-token');
    
            if (!nsUrl || !nsToken) {
                this._updateErrorState('⚠️ Settings');
                return;
            }
    
            const baseUrl = nsUrl.replace(/\/$/, '');
            const token = nsToken.replace(/^\/?[?]token=/, '');
            const url = `${baseUrl}/api/v1/entries.json?count=2`;
    
            try {
                const session = new Soup.Session();
                session.timeout = 10; // 10 second timeout
                const message = Soup.Message.new('GET', url);
    
                if (!message) {
                    throw new Error('Invalid URL');
                }
    
                message.request_headers.append('api-secret', token);
                message.request_headers.append('Accept', 'application/json');
    
                console.error('Fetching from:', url);
                const bytes = await session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
    
                if (message.status_code !== 200) {
                    throw new Error(`HTTP error! status: ${message.status_code}`);
                }
    
                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(bytes.get_data());
                const data = JSON.parse(text);
    
                if (!Array.isArray(data) || data.length < 2) {
                    throw new Error('Not enough glucose data available');
                }
    
                // Process data and update display
                const [current, previous] = data;
                
                // Calculate delta
                const delta = current.sgv - previous.sgv;
                current.delta = delta;
    
                // Update displays
                this._updateMainDisplay(current);
                this._updateMenuDisplay(current);
                
                // Store reading and check alerts
                this._lastReading = current;
                this._checkAndAlert(current.sgv);
    
            } catch (networkError) {
                console.error('Network error:', networkError);
                // Show specific error message based on error type
                if (networkError.message.includes('No route to host')) {
                    this._updateErrorState('⚠️ No Connection');
                } else if (networkError.message.includes('Invalid URL')) {
                    this._updateErrorState('⚠️ Invalid URL');
                } else {
                    this._updateErrorState('⚠️ Network Error');
                }
                
                // Update menu with error state
                this._updateMenuError('Cannot connect to Nightscout server. Check your connection and settings.');
            }
    
        } catch (error) {
            console.error('Nightscout Error:', error);
            this._updateErrorState(ERROR_TEXT);
        }
    }

    _updateErrorState(message) {
        if (this._isDestroyed) return;
    
        const glucoseLabel = this._elements.get('glucoseLabel');
        const secondaryInfo = this._elements.get('secondaryInfo');
    
        if (glucoseLabel) {
            glucoseLabel.set_text(message);
            glucoseLabel.set_style('color: red;');
        }
    
        if (secondaryInfo) {
            secondaryInfo.set_text('');
        }
    }

    _updateMenuError(message) {
        if (this._isDestroyed) return;
    
        try {
            const menuItem = this._elements.get('menuItem');
            const deltaItem = this._elements.get('deltaItem');
            const trendItem = this._elements.get('trendItem');
            const elapsedTimeItem = this._elements.get('elapsedTimeItem');
    
            if (menuItem && menuItem.label) {
                menuItem.label.set_text(message);
            }
    
            // Clear other menu items
            if (deltaItem && deltaItem.label) deltaItem.label.set_text('Delta: --');
            if (trendItem && trendItem.label) trendItem.label.set_text('Trend: --');
            if (elapsedTimeItem && elapsedTimeItem.label) elapsedTimeItem.label.set_text('Time: --');
        } catch (error) {
            console.error('Error updating menu error state:', error);
        }
    }
    
    _updateMainDisplay(reading) {
        if (this._isDestroyed) return;
    
        try {
            const glucoseLabel = this._elements.get('glucoseLabel');
            const secondaryInfo = this._elements.get('secondaryInfo');
    
            if (!glucoseLabel || !secondaryInfo) return;
    
            // Update glucose value
            glucoseLabel.set_text(`${reading.sgv}`);
            glucoseLabel.set_style(`color: ${this._getColorForGlucose(reading.sgv)};`);
    
            // Build secondary info string
            let secondaryText = '';
    
            // Add trend arrow
            if (reading.direction || reading.calculatedTrend) {
                secondaryText += reading.direction || reading.calculatedTrend;
            }
    
            // Add delta
            if (typeof reading.delta === 'number' || typeof reading.calculatedDelta === 'number') {
                const deltaValue = reading.delta || reading.calculatedDelta;
                secondaryText += ` ${deltaValue > 0 ? '+' : ''}${deltaValue}`;
            }
    
            // Add time
            if (reading.dateString) {
                const now = new Date();
                const readingTime = new Date(reading.dateString);
                const minutesDiff = Math.floor((now - readingTime) / (1000 * 60));
                secondaryText += ` ${minutesDiff}m`;
            }
    
            secondaryInfo.set_text(secondaryText);
    
        } catch (error) {
            console.error('Error updating main display:', error);
            if (glucoseLabel) {
                glucoseLabel.set_text(ERROR_TEXT);
                glucoseLabel.set_style('color: red;');
            }
        }
    }
    
    _createUI() {
        console.error('Creating UI');
        try {
            // Main container
            this.boxLayout = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
                y_align: Clutter.ActorAlign.CENTER
            });
            this._elements.set('boxLayout', this.boxLayout);
    
            // Create icon
            try {
                this.icon = new St.Icon({
                    gicon: Gio.Icon.new_for_string(`${this._extension.path}/icons/icon.svg`),
                    style_class: 'system-status-icon'
                });
                this._elements.set('icon', this.icon);
                this.boxLayout.add_child(this.icon);
            } catch (error) {
                console.error('Error creating icon:', error);
            }
    
            // Wrapper box for value and superscript
            this.valueWrapper = new St.BoxLayout({
                style: 'spacing: 0px;'
            });
    
            // Main glucose label
            this.glucoseLabel = new St.Label({
                text: LOADING_TEXT,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-right: 1px;'
            });
            this._elements.set('glucoseLabel', this.glucoseLabel);
    
            // Superscript info
            this.secondaryInfo = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.START,
                style: 'font-size: 0.65em; margin-top: 2px;'
            });
            this._elements.set('secondaryInfo', this.secondaryInfo);
    
            // Add to layout
            this.valueWrapper.add_child(this.glucoseLabel);
            this.valueWrapper.add_child(this.secondaryInfo);
            this.boxLayout.add_child(this.valueWrapper);
            this.add_child(this.boxLayout);
    
            // Create menu items
            this._createMenuSection();
    
        } catch (error) {
            console.error('Error in _createUI:', error);
        }
    }

    _createMenuItem(key, text) {
        const item = new PopupMenu.PopupMenuItem(text);
        this._elements.set(key, item);
        this.menu.addMenuItem(item);
        return item;
    }
    _updateLabel(elementKey, text) {
        const element = this._elements.get(elementKey);
        if (element && !this._isDestroyed) {
            if (element instanceof PopupMenu.PopupMenuItem) {
                element.label.set_text(text);
            } else if (element instanceof St.Label) {
                element.set_text(text);
            }
        }
    }
    _getColorForGlucose(sgv) {
        const urgentHighThreshold = this._settings.get_int('urgent-high-threshold');
        const highThreshold = this._settings.get_int('high-threshold');
        const lowThreshold = this._settings.get_int('low-threshold');
        const urgentLowThreshold = this._settings.get_int('urgent-low-threshold');

        if (sgv >= urgentHighThreshold) {
            return this._settings.get_string('urgent-high-color');
        } else if (sgv >= highThreshold) {
            return this._settings.get_string('high-color');
        } else if (sgv <= urgentLowThreshold) {
            return this._settings.get_string('urgent-low-color');
        } else if (sgv <= lowThreshold) {
            return this._settings.get_string('low-color');
        } else {
            return this._settings.get_string('normal-color');
        }
    }

    _startMonitoring() {
        try {
            // Initial update
            this._updateGlucose().catch(error => {
                console.error('Error in initial update:', error);
            });
    
            // Update periodically
            this._timeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                UPDATE_INTERVAL,
                () => {
                    if (this._isDestroyed) {
                        return GLib.SOURCE_REMOVE;
                    }
                    this._updateGlucose().catch(error => {
                        console.error('Error in periodic update:', error);
                    });
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } catch (error) {
            console.error('Error starting monitoring:', error);
        }
    }

    async _updateGlucose() {
        if (this._isDestroyed) return;
    
        try {
            const nsUrl = this._settings.get_string('nightscout-url');
            const nsToken = this._settings.get_string('nightscout-token');
    
            if (!nsUrl || !nsToken) {
                this._updateLabel('label', '⚠️ Settings');
                return;
            }
    
            const baseUrl = nsUrl.replace(/\/$/, '');
            const token = nsToken.replace(/^\/?[?]token=/, '');
            const url = `${baseUrl}/api/v1/entries.json?count=2`;
    
            const session = new Soup.Session();
            const message = Soup.Message.new('GET', url);
    
            message.request_headers.append('api-secret', token);
            message.request_headers.append('Accept', 'application/json');
    
            const bytes = await session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null
            );
    
            if (message.status_code !== 200) {
                throw new Error(`HTTP error! status: ${message.status_code}`);
            }
    
            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(bytes.get_data());
            const data = JSON.parse(text);
    
            if (!Array.isArray(data) || data.length < 2) {
                throw new Error('Not enough glucose data available');
            }
    
            // Get current and previous readings
            const current = data[0];
            const previous = data[1];
    
            // Calculate delta
            const delta = current.sgv - previous.sgv;
            current.delta = delta;
            current.calculatedDelta = delta;
    
            // Calculate trend
            const trend = this._calculateTrendArrow([current, previous]);
            current.direction = trend;
            current.calculatedTrend = trend;
    
            // Store both readings
            this._lastReading = current;
            
            // Update displays
            this._updateMainDisplay(current);
            this._updateMenuDisplay(current);
            
            // Check alerts
            this._checkAndAlert(current.sgv);
    
        } catch (error) {
            console.error('Nightscout Error:', error);
            if (!this._isDestroyed) {
                this._updateLabel('label', ERROR_TEXT);
                const mainLabel = this._elements.get('label');
                if (mainLabel) {
                    mainLabel.set_style('color: red;');
                }
            }
        }
    }
 
    _calculateTrendArrow(readings) {
        try {
            // If we have only one reading
            if (!Array.isArray(readings) || readings.length < 2) {
                return '→';
            }
    
            const current = readings[0]?.sgv;
            const previous = readings[1]?.sgv;
            
            // Check for valid numbers
            if (typeof current !== 'number' || typeof previous !== 'number') {
                return '→';
            }
    
            const currentTime = new Date(readings[0]?.dateString);
            const previousTime = new Date(readings[1]?.dateString);
    
            // Check for valid dates
            if (isNaN(currentTime.getTime()) || isNaN(previousTime.getTime())) {
                return '→';
            }
    
            const timeDiff = (currentTime - previousTime) / (1000 * 60);
            if (timeDiff <= 0 || timeDiff > 15) {
                return '→';
            }
    
            const rateOfChange = (current - previous) / timeDiff;
    
            // Return arrow based on rate of change
            if (rateOfChange >= DELTA_THRESHOLDS.VERY_FAST_RISE) return '↑↑';
            if (rateOfChange >= DELTA_THRESHOLDS.FAST_RISE) return '↑';
            if (rateOfChange >= DELTA_THRESHOLDS.MODERATE_RISE) return '↗';
            if (rateOfChange <= DELTA_THRESHOLDS.VERY_FAST_FALL) return '↓↓';
            if (rateOfChange <= DELTA_THRESHOLDS.FAST_FALL) return '↓';
            if (rateOfChange <= DELTA_THRESHOLDS.MODERATE_FALL) return '↘';
            return '→';
        } catch (error) {
            console.error('Error calculating trend:', error);
            return '→';
        }
    }

    _calculateDelta(readings) {
        try {
            // If we have only one reading
            if (!Array.isArray(readings) || readings.length < 2) {
                return '0.0';
            }
    
            const current = readings[0]?.sgv;
            const previous = readings[1]?.sgv;
    
            // Check if we have valid numbers
            if (typeof current !== 'number' || typeof previous !== 'number') {
                return '0.0';
            }
    
            const delta = current - previous;
            return delta.toFixed(1);
        } catch (error) {
            console.error('Error calculating delta:', error);
            return '0.0';
        }
    }

    _formatElapsedTime(date) {
        try {
            const now = new Date();
            const diff = now - date;
            const minutes = Math.floor(diff / 60000);
            return `${minutes}m`;
        } catch (error) {
            console.error('Error formatting time:', error);
            return '0m';
        }
    }

    _playAlert() {
        if (this._isDestroyed) return;
        
        console.error('Starting alert playback...');
        try {
            const soundPath = GLib.build_filenamev([this._extension.path, 'sounds', 'alert.mp3']);
            if (!GLib.file_test(soundPath, GLib.FileTest.EXISTS)) {
                console.error('Alert sound file not found:', soundPath);
                return;
            }

            // Simple paplay approach
            try {
                GLib.spawn_command_line_async(`paplay "${soundPath}"`);
                console.error('Started paplay playback');
                this._lastAlertTime = Date.now();
            } catch (error) {
                console.error('Error playing alert:', error);
            }
        } catch (error) {
            console.error('Alert playback failed:', error);
        }
    }
    
    _createMenuSection() {
        try {
            // Create menu items
            const menuItem = new PopupMenu.PopupMenuItem('Last reading: ' + LOADING_TEXT, {
                reactive: true,
                can_focus: true
            });
            this._elements.set('menuItem', menuItem);
            this.menu.addMenuItem(menuItem);
    
            const deltaItem = new PopupMenu.PopupMenuItem('Delta: ' + LOADING_TEXT, {
                reactive: true,
                can_focus: true
            });
            this._elements.set('deltaItem', deltaItem);
            this.menu.addMenuItem(deltaItem);
    
            const trendItem = new PopupMenu.PopupMenuItem('Trend: ' + LOADING_TEXT, {
                reactive: true,
                can_focus: true
            });
            this._elements.set('trendItem', trendItem);
            this.menu.addMenuItem(trendItem);
    
            const elapsedTimeItem = new PopupMenu.PopupMenuItem('Time: ' + LOADING_TEXT, {
                reactive: true,
                can_focus: true
            });
            this._elements.set('elapsedTimeItem', elapsedTimeItem);
            this.menu.addMenuItem(elapsedTimeItem);
    
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    
            // Add Refresh button
            const refreshButton = new PopupMenu.PopupMenuItem('Refresh Now', {
                reactive: true,
                can_focus: true
            });
            this._elements.set('refreshButton', refreshButton);
            refreshButton.connect('activate', () => {
                if (!this._isDestroyed) {
                    this._updateGlucose().catch(error => console.error('Refresh error:', error));
                }
                this.menu.close();
            });
            this.menu.addMenuItem(refreshButton);
    
            // Add Settings button
            const settingsButton = new PopupMenu.PopupMenuItem('Open Settings', {
                reactive: true,
                can_focus: true
            });
            this._elements.set('settingsButton', settingsButton);
            settingsButton.connect('activate', () => {
                if (!this._isDestroyed) {
                    this._extension.openPreferences();
                }
                this.menu.close();
            });
            this.menu.addMenuItem(settingsButton);
    
        } catch (error) {
            console.error('Error in _createMenuSection:', error);
        }
    }

// Update the destroy method to be more thorough
destroy() {
    if (this._isDestroyed) return;
    
    console.error('Destroying NightscoutIndicator');
    this._isDestroyed = true;

    if (this._timeout) {
        GLib.source_remove(this._timeout);
        this._timeout = null;
    }

    if (this._settingsChangedId) {
        try {
            this._settings.disconnect(this._settingsChangedId);
        } catch (error) {
            console.error('Error disconnecting settings:', error);
        }
        this._settingsChangedId = null;
    }

    try {
        // Remove children from layout
        if (this.boxLayout) {
            this.boxLayout.get_children().forEach(child => {
                try {
                    this.boxLayout.remove_child(child);
                } catch (error) {
                    console.error('Error removing child:', error);
                }
            });
        }

        // Clear all elements
        this._elements.clear();

        super.destroy();
    } catch (error) {
        console.error('Error in destroy:', error);
    }
}
});

export default class NightscoutExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        console.error('Initializing NightscoutExtension');
        this._lastAlertTime = 0;
        this._indicator = null;
        this._settings = null;
        this._isEnabled = false;
        this._recoveryTimeout = null;
    }

    enable() {
        console.error('Enabling NightscoutExtension');
        if (this._isEnabled) return;

        try {
            this._isEnabled = true;
            this._settings = this.getSettings();

            // Initialize with delay to ensure shell is ready
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._isEnabled) return GLib.SOURCE_REMOVE;
                this._initializeExtension();
                return GLib.SOURCE_REMOVE;
            });

            // Set up periodic recovery check
            this._recoveryTimeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                30, // Check every 30 seconds
                () => {
                    if (!this._isEnabled) return GLib.SOURCE_REMOVE;
                    this._checkAndRecover();
                    return GLib.SOURCE_CONTINUE;
                }
            );

        } catch (error) {
            console.error('Error in enable():', error);
            this._isEnabled = false;
        }
    }

    _checkAndRecover() {
        try {
            // Check if indicator is still valid
            if (!this._indicator || this._indicator._isDestroyed) {
                console.error('Indicator needs recovery, reinitializing...');
                if (this._indicator) {
                    try {
                        this._indicator.destroy();
                    } catch (e) {
                        console.error('Error destroying old indicator:', e);
                    }
                }
                this._indicator = null;
                this._initializeExtension();
            }
        } catch (error) {
            console.error('Error in recovery check:', error);
        }
    }

    _initializeExtension() {
        try {
            if (!this._isEnabled || this._indicator) return;

            // Create indicator
            this._indicator = new NightscoutIndicator(this._settings, this);
            const position = this._settings.get_string('icon-position');
            
            if (position === 'left') {
                Main.panel.addToStatusArea('nightscout-indicator', this._indicator, 1, 'left');
            } else {
                Main.panel.addToStatusArea('nightscout-indicator', this._indicator, 0, 'right');
            }
            console.error('Successfully added indicator to panel');

        } catch (error) {
            console.error('Error initializing extension:', error);
        }
    }

    _recoverExtension() {
        try {
            // Clean up old indicator if it exists
            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }

            // Reinitialize
            this._initializeExtension();
        } catch (error) {
            console.error('Error recovering extension:', error);
        }
    }

    disable() {
        console.error('Disabling NightscoutExtension');
        try {
            this._isEnabled = false;

            // Clear recovery timeout
            if (this._recoveryTimeout) {
                GLib.source_remove(this._recoveryTimeout);
                this._recoveryTimeout = null;
            }

            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
            this._settings = null;
        } catch (error) {
            console.error('Error in disable():', error);
        }
    }
}
