'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

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

const ERROR_TEXT = '⚠️ Error';
const LOADING_TEXT = '---';

const NightWatcherIndicator = GObject.registerClass(
    class NightWatcherIndicator extends PanelMenu.Button {
        _init(settings, extension) {
            super._init(0.0, 'NightWatcher Monitor');

            this._settings = settings;
            this._extension = extension;
            this._lastReading = null;
            this._timeout = null;
            this._retryTimeout = null;
            this._isDestroyed = false;
            this._elements = new Map();
            this._lastAlertTime = 0;
            this._retryCount = 0;
            this._dataHistory = [];
            this._maxHistoryItems = 288; // 24 hours worth (5 min intervals)
            this._connectionStatus = 'unknown'; // 'unknown', 'connected', 'error'

            this._createUI();

            this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
                if (key === 'update-interval') {
                    this._restartMonitoring();
                } else {
                    this._updateDisplay();
                }
            });

            this._startMonitoring();
        }

        _log(message, data = null) {
            if (this._settings.get_boolean('enable-debug-logs')) {
                const prefix = '[NightWatcher]';
                if (data) {
                    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
                } else {
                    console.log(`${prefix} ${message}`);
                }
            }
        }

        _startMonitoring() {
            try {
                this._log('Starting monitoring...');

                // Initial update
                this._updateGlucose().catch(error => {
                    this._log('Error in initial update', error);
                    console.log('Error in initial update:', error);
                });

                // Schedule periodic updates
                this._scheduleNextUpdate();
            } catch (error) {
                this._log('Error starting monitoring', error);
                console.log('Error starting monitoring:', error);
            }
        }

        _scheduleNextUpdate() {
            // Remove existing timeout if any
            this._removeTimeout();

            if (this._isDestroyed) return;

            const updateInterval = this._settings.get_int('update-interval');
            this._log(`Scheduling next update in ${updateInterval} seconds`);

            this._timeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                updateInterval,
                () => {
                    if (this._isDestroyed) {
                        this._timeout = null;
                        return GLib.SOURCE_REMOVE;
                    }

                    this._updateGlucose().catch(error => {
                        this._log('Error in periodic update', error);
                        console.log('Error in periodic update:', error);
                    });

                    // Schedule next update
                    this._scheduleNextUpdate();
                    this._timeout = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        _removeTimeout() {
            if (this._timeout) {
                GLib.source_remove(this._timeout);
                this._timeout = null;
            }
        }

        _removeRetryTimeout() {
            if (this._retryTimeout) {
                GLib.source_remove(this._retryTimeout);
                this._retryTimeout = null;
            }
        }

        _restartMonitoring() {
            this._log('Restarting monitoring with new settings...');
            this._removeTimeout();
            this._removeRetryTimeout();
            this._scheduleNextUpdate();
        }
    
        _updateDisplay() {
            if (this._isDestroyed) return;
        
            const showIcon = this._settings.get_boolean('show-icon');
            const icon = this._elements.get('icon');
            if (icon) {
                icon.visible = showIcon;
            }
        
            if (this._lastReading) {
                this._updateMainDisplay(this._lastReading);
            }
        }

        _updateMainDisplay(reading) {
            if (this._isDestroyed) return;

            try {
                this._log('Updating main display', { sgv: reading.sgv, trend: reading.direction });

                const glucoseLabel = this._elements.get('glucoseLabel');
                const secondaryInfo = this._elements.get('secondaryInfo');

                if (!glucoseLabel || !secondaryInfo) return;

                glucoseLabel.set_text(`${reading.sgv}`);
                glucoseLabel.set_style(`color: ${this._getColorForGlucose(reading.sgv)};`);

                let secondaryText = '';

                if (reading.direction || reading.calculatedTrend) {
                    secondaryText += reading.direction || reading.calculatedTrend;
                }

                if (typeof reading.delta === 'number' || typeof reading.calculatedDelta === 'number') {
                    const deltaValue = reading.delta || reading.calculatedDelta;
                    secondaryText += ` ${deltaValue > 0 ? '+' : ''}${deltaValue}`;
                }

                if (reading.dateString) {
                    const now = new Date();
                    const readingTime = new Date(reading.dateString);
                    const minutesDiff = Math.floor((now - readingTime) / (1000 * 60));
                    secondaryText += ` ${minutesDiff}m`;
                }

                secondaryInfo.set_text(secondaryText);

            } catch (error) {
                this._log('Error updating main display', error);
                console.log('Error updating main display:', error);
                if (glucoseLabel) {
                    glucoseLabel.set_text(ERROR_TEXT);
                    glucoseLabel.set_style('color: red;');
                }
            }
        }
    
        _createUI() {
           
            this.boxLayout = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
                y_align: Clutter.ActorAlign.CENTER
            });
            this._elements.set('boxLayout', this.boxLayout);
        
           
            this.icon = new St.Icon({
                gicon: Gio.Icon.new_for_string(`${this._extension.path}/icons/icon.svg`),
                style_class: 'system-status-icon'
            });
            this._elements.set('icon', this.icon);
            this.boxLayout.add_child(this.icon);
                
           
            this.valueWrapper = new St.BoxLayout({
                style: 'spacing: 0px;'
            });
    
           
            this.glucoseLabel = new St.Label({
                text: LOADING_TEXT,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-right: 1px;'
            });
            this._elements.set('glucoseLabel', this.glucoseLabel);
    
           
            this.secondaryInfo = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.START,
                style: 'font-size: 0.65em; margin-top: 2px;'
            });
            this._elements.set('secondaryInfo', this.secondaryInfo);
    
           
            this.valueWrapper.add_child(this.glucoseLabel);
            this.valueWrapper.add_child(this.secondaryInfo);
            this.boxLayout.add_child(this.valueWrapper);
            this.add_child(this.boxLayout);
    
           
            this._createMenuSection();
        }
        _createMenuSection() {
            // Current Reading Section
            const menuItems = [
                ['menuItem', 'Last reading: '],
                ['deltaItem', 'Delta: '],
                ['trendItem', 'Trend: '],
                ['elapsedTimeItem', 'Time: ']
            ];

            menuItems.forEach(([key, label]) => {
                const item = new PopupMenu.PopupMenuItem(`${label}${LOADING_TEXT}`, {
                    reactive: false,
                    can_focus: false
                });
                this._elements.set(key, item);
                this.menu.addMenuItem(item);
            });

            // Connection Status
            const statusItem = new PopupMenu.PopupMenuItem('Status: Unknown', {
                reactive: false,
                can_focus: false
            });
            this._elements.set('statusItem', statusItem);
            this.menu.addMenuItem(statusItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // History Section
            const historySubmenu = new PopupMenu.PopupSubMenuMenuItem('Data History (Last 24h)');
            this._elements.set('historySubmenu', historySubmenu);
            this.menu.addMenuItem(historySubmenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Refresh Button
            const refreshButton = this._createMenuItem('refreshButton', '🔄 Refresh Now', () => {
                this._updateGlucose().catch(error => console.log('Refresh error:', error));
                this.menu.close();
            });

            // Settings Button
            const settingsButton = this._createMenuItem('settingsButton', '⚙️ Open Settings', () => {
                this._extension.openPreferences();
                this.menu.close();
            });
        }
        _createMenuItem(key, label, callback) {
            const item = new PopupMenu.PopupMenuItem(label, {
                reactive: true,
                can_focus: true
            });
            this._elements.set(key, item);
            if (callback) {
                item.connect('activate', callback);
            }
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
        async _updateGlucose() {
            if (this._isDestroyed) return;

            try {
                this._log('Fetching glucose data...');

                const nsUrl = this._settings.get_string('nightscout-url');
                const nsToken = this._settings.get_string('nightscout-token');

                if (!nsUrl || !nsToken) {
                    this._log('Missing URL or token in settings');
                    this._updateErrorState('⚠️ Settings');
                    this._connectionStatus = 'error';
                    return;
                }

                const baseUrl = nsUrl.replace(/\/$/, '');
                const token = nsToken.replace(/^\/?[?]token=/, '');
                const url = `${baseUrl}/api/v1/entries.json?count=2`;

                this._log('API URL', { url: baseUrl });

                const session = new Soup.Session();
                session.timeout = 30; // 30 second timeout

                // Configure TLS/SSL certificate validation
                const skipTlsVerification = this._settings.get_boolean('skip-tls-verification');
                if (skipTlsVerification) {
                    this._log('TLS certificate verification disabled (skip-tls-verification = true)');
                    // Disable SSL/TLS certificate validation for self-signed certificates
                    session.ssl_strict = false;
                }

                const message = Soup.Message.new('GET', url);

                message.request_headers.append('api-secret', token);
                message.request_headers.append('Accept', 'application/json');

                const bytes = await session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                this._log('API Response', { status: message.status_code });

                if (message.status_code !== 200) {
                    throw new Error(`HTTP error! status: ${message.status_code}`);
                }

                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(bytes.get_data());
                const data = JSON.parse(text);

                this._log('Data received', { entries: data.length });

                if (!Array.isArray(data) || data.length < 2) {
                    throw new Error('Not enough glucose data available');
                }

                const [current, previous] = data;
                const delta = current.sgv - previous.sgv;
                current.delta = delta;
                current.calculatedDelta = delta;

                const trend = this._calculateTrendArrow([current, previous]);
                current.direction = trend;
                current.calculatedTrend = trend;

                this._log('Glucose reading', {
                    sgv: current.sgv,
                    delta: delta,
                    trend: trend,
                    time: current.dateString
                });

                // Success! Reset retry count and update connection status
                this._retryCount = 0;
                this._connectionStatus = 'connected';
                this._lastReading = current;

                // Add to history
                this._addToHistory(current);

                this._updateMainDisplay(current);
                this._updateMenuDisplay(current);
                this._checkAndAlert(current.sgv);

            } catch (error) {
                this._log('Nightwatcher Error', error);
                console.log('Nightwatcher Error:', error);
                this._connectionStatus = 'error';

                if (!this._isDestroyed) {
                    this._handleNetworkError(error);
                }
            }
        }

        _handleNetworkError(error) {
            const maxRetries = this._settings.get_int('max-retries');
            const baseRetryDelay = this._settings.get_int('retry-delay');

            this._log('Handling network error', {
                retryCount: this._retryCount,
                maxRetries: maxRetries
            });

            if (this._retryCount < maxRetries) {
                this._retryCount++;
                const retryDelay = baseRetryDelay * Math.pow(2, this._retryCount - 1); // Exponential backoff

                this._log(`Scheduling retry ${this._retryCount}/${maxRetries} in ${retryDelay}s`);

                this._updateErrorState(`⚠️ Retry ${this._retryCount}/${maxRetries}`);

                // Schedule retry
                this._removeRetryTimeout();
                this._retryTimeout = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    retryDelay,
                    () => {
                        if (this._isDestroyed) {
                            this._retryTimeout = null;
                            return GLib.SOURCE_REMOVE;
                        }

                        this._log('Executing retry attempt');
                        this._updateGlucose().catch(err => {
                            this._log('Retry failed', err);
                        });

                        this._retryTimeout = null;
                        return GLib.SOURCE_REMOVE;
                    }
                );
            } else {
                // Max retries reached
                this._log('Max retries reached, showing error');
                this._updateErrorState('⚠️ No Connection');

                // Show notification if enabled
                if (this._settings.get_boolean('enable-notifications')) {
                    this._showNotification(
                        'NightWatcher Connection Error',
                        'Failed to connect to Nightscout server. Please check your connection.'
                    );
                }

                // Reset retry count for next cycle
                this._retryCount = 0;
            }
        }

        _showNotification(title, message) {
            try {
                Main.notify(title, message);
                this._log('Notification shown', { title, message });
            } catch (error) {
                this._log('Failed to show notification', error);
            }
        }

        _addToHistory(reading) {
            if (!reading || !reading.sgv) return;

            const historyEntry = {
                sgv: reading.sgv,
                delta: reading.delta || reading.calculatedDelta || 0,
                trend: reading.direction || reading.calculatedTrend || '→',
                timestamp: reading.dateString || new Date().toISOString(),
                date: Date.now()
            };

            this._dataHistory.push(historyEntry);

            // Keep only the last 24 hours
            if (this._dataHistory.length > this._maxHistoryItems) {
                this._dataHistory.shift();
            }

            this._log('Added to history', {
                entries: this._dataHistory.length,
                max: this._maxHistoryItems
            });
        }

        _playAlert() {
            if (this._isDestroyed) return;

            this._log('Starting alert playback...');
            console.log('Starting alert playback...');
            try {
                const soundPath = GLib.build_filenamev([this._extension.path, 'sounds', 'alert.mp3']);
                if (!GLib.file_test(soundPath, GLib.FileTest.EXISTS)) {
                    this._log('Alert sound file not found', { path: soundPath });
                    console.log('Alert sound file not found:', soundPath);
                    return;
                }

                try {
                    GLib.spawn_command_line_async(`paplay "${soundPath}"`);
                    this._log('Alert playback started successfully');
                    console.log('Started paplay playback');
                    this._lastAlertTime = Date.now();
                } catch (error) {
                    this._log('Error playing alert', error);
                    console.log('Error playing alert:', error);
                }
            } catch (error) {
                this._log('Alert playback failed', error);
                console.log('Alert playback failed:', error);
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
        _updateMenuDisplay(reading) {
            if (this._isDestroyed) return;

            try {
                const menuItem = this._elements.get('menuItem');
                const deltaItem = this._elements.get('deltaItem');
                const trendItem = this._elements.get('trendItem');
                const elapsedTimeItem = this._elements.get('elapsedTimeItem');
                const statusItem = this._elements.get('statusItem');

                if (menuItem && menuItem.label) {
                    menuItem.label.set_text(`Last reading: ${reading.sgv} mg/dL`);
                }

                if (deltaItem && deltaItem.label) {
                    const delta = reading.delta || reading.calculatedDelta;
                    if (typeof delta === 'number') {
                        const sign = delta > 0 ? '+' : '';
                        deltaItem.label.set_text(`Delta: ${sign}${delta} mg/dL`);
                    } else {
                        deltaItem.label.set_text('Delta: --');
                    }
                }

                if (trendItem && trendItem.label) {
                    const trend = reading.direction || reading.calculatedTrend;
                    trendItem.label.set_text(`Trend: ${trend || '→'}`);
                }

                if (elapsedTimeItem && elapsedTimeItem.label && reading.dateString) {
                    const now = new Date();
                    const readingTime = new Date(reading.dateString);
                    const minutesDiff = Math.floor((now - readingTime) / (1000 * 60));
                    elapsedTimeItem.label.set_text(`Time: ${minutesDiff}m ago`);
                }

                // Update connection status
                if (statusItem && statusItem.label) {
                    const statusText = this._connectionStatus === 'connected' ? '✓ Connected' :
                                      this._connectionStatus === 'error' ? '✗ Connection Error' :
                                      '? Unknown';
                    statusItem.label.set_text(`Status: ${statusText}`);
                }

                // Update history submenu
                this._updateHistorySubmenu();

            } catch (error) {
                console.log('Error updating menu display:', error);
            }
        }

        _updateHistorySubmenu() {
            const historySubmenu = this._elements.get('historySubmenu');
            if (!historySubmenu) return;

            try {
                // Clear existing items
                historySubmenu.menu.removeAll();

                if (this._dataHistory.length === 0) {
                    const noDataItem = new PopupMenu.PopupMenuItem('No data available', {
                        reactive: false,
                        can_focus: false
                    });
                    historySubmenu.menu.addMenuItem(noDataItem);
                    return;
                }

                // Add summary statistics
                const stats = this._calculateHistoryStats();
                const statsItem = new PopupMenu.PopupMenuItem(
                    `Avg: ${stats.avg} | Min: ${stats.min} | Max: ${stats.max} | Entries: ${stats.count}`,
                    { reactive: false, can_focus: false }
                );
                historySubmenu.menu.addMenuItem(statsItem);
                historySubmenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                // Show last 10 readings
                const recentReadings = this._dataHistory.slice(-10).reverse();
                recentReadings.forEach((entry, index) => {
                    const time = new Date(entry.timestamp);
                    const timeStr = time.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    const deltaStr = entry.delta > 0 ? `+${entry.delta}` : entry.delta;
                    const text = `${timeStr} | ${entry.sgv} mg/dL ${entry.trend} (${deltaStr})`;
                    const item = new PopupMenu.PopupMenuItem(text, {
                        reactive: false,
                        can_focus: false
                    });
                    historySubmenu.menu.addMenuItem(item);
                });

            } catch (error) {
                this._log('Error updating history submenu', error);
            }
        }

        _calculateHistoryStats() {
            if (this._dataHistory.length === 0) {
                return { avg: 0, min: 0, max: 0, count: 0 };
            }

            const values = this._dataHistory.map(entry => entry.sgv);
            const sum = values.reduce((a, b) => a + b, 0);
            const avg = Math.round(sum / values.length);
            const min = Math.min(...values);
            const max = Math.max(...values);

            return {
                avg: avg,
                min: min,
                max: max,
                count: this._dataHistory.length
            };
        }
        _checkAndAlert(sgv) {
            if (!this._settings.get_boolean('enable-alerts')) return;
    
            const now = Date.now();
            const alertInterval = this._settings.get_int('alert-interval') * 1000;
            
            if (now - this._lastAlertTime < alertInterval) return;
    
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
    
        _calculateTrendArrow(readings) {
            if (!Array.isArray(readings) || readings.length < 2) return '→';
    
            const current = readings[0]?.sgv;
            const previous = readings[1]?.sgv;
            
            if (typeof current !== 'number' || typeof previous !== 'number') return '→';
    
            const currentTime = new Date(readings[0]?.dateString);
            const previousTime = new Date(readings[1]?.dateString);
    
            if (isNaN(currentTime.getTime()) || isNaN(previousTime.getTime())) return '→';
    
            const timeDiff = (currentTime - previousTime) / (1000 * 60);
            if (timeDiff <= 0 || timeDiff > 15) return '→';
    
            const rateOfChange = (current - previous) / timeDiff;
    
            if (rateOfChange >= DELTA_THRESHOLDS.VERY_FAST_RISE) return '↑↑';
            if (rateOfChange >= DELTA_THRESHOLDS.FAST_RISE) return '↑';
            if (rateOfChange >= DELTA_THRESHOLDS.MODERATE_RISE) return '↗';
            if (rateOfChange <= DELTA_THRESHOLDS.VERY_FAST_FALL) return '↓↓';
            if (rateOfChange <= DELTA_THRESHOLDS.FAST_FALL) return '↓';
            if (rateOfChange <= DELTA_THRESHOLDS.MODERATE_FALL) return '↘';
            return '→';
        }
        destroy() {
            if (this._isDestroyed) return;

            this._log('Destroying NightWatcher indicator...');
            this._isDestroyed = true;

            // Remove all timeouts - CRITICAL for GNOME 49 compliance
            this._removeTimeout();
            this._removeRetryTimeout();

            // Disconnect settings signal
            if (this._settingsChangedId) {
                try {
                    this._settings.disconnect(this._settingsChangedId);
                } catch (error) {
                    console.log('Error disconnecting settings:', error);
                }
                this._settingsChangedId = null;
            }

            // Clear UI elements
            if (this.boxLayout) {
                this.boxLayout.get_children().forEach(child => {
                    try {
                        this.boxLayout.remove_child(child);
                    } catch (error) {
                        console.log('Error removing child:', error);
                    }
                });
            }

            // Clear data
            this._elements.clear();
            this._dataHistory = [];

            super.destroy();
            this._log('NightWatcher indicator destroyed');
        }
    });
    
    export default class NightwatcherExtension extends Extension {
        constructor(metadata) {
            super(metadata);
            this._indicator = null;
            this._settings = null;
        }
    
        enable() {
            this._settings = this.getSettings();
            this._initializeExtension();
        }
    
        _initializeExtension() {
            if (this._indicator) return;
    
            this._indicator = new NightWatcherIndicator(this._settings, this);
            const position = this._settings.get_string('icon-position');
    
            if (position === 'left') {
                Main.panel.addToStatusArea('nightwatcher-indicator', this._indicator, 1, 'left');
            } else {
                Main.panel.addToStatusArea('nightwatcher-indicator', this._indicator, 0, 'right');
            }
        }
    
        disable() {
            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
            this._settings = null;
        }
    }