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

const UPDATE_INTERVAL = 60;
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
            this._isDestroyed = false;
            this._elements = new Map();
            this._lastAlertTime = 0;
    
            this._createUI();
    
            this._settingsChangedId = this._settings.connect('changed', () => {
                this._updateDisplay();
            });
    
            this._startMonitoring();
        }

        _debugLog(...args) {
            if (this._settings.get_boolean('enable-debug-log')) {
                console.debug('[NightWatcher]', ...args);
            }
        }

        _startMonitoring() {
            try {
               
                this._updateGlucose().catch(error => {
                    console.log('[NightWatcher] Error in initial update:', error);
                });


                this._timeout = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    UPDATE_INTERVAL,
                    () => {
                        if (this._isDestroyed) {
                            return GLib.SOURCE_REMOVE;
                        }
                        this._updateGlucose().catch(error => {
                            console.log('[NightWatcher] Error in periodic update:', error);
                        });
                        return GLib.SOURCE_CONTINUE;
                    }
                );
            } catch (error) {
                console.log('[NightWatcher] Error starting monitoring:', error);
            }
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
                console.log('[NightWatcher] Error updating main display:', error);
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
           
            const menuItems = [
                ['menuItem', 'Last reading: '],
                ['deltaItem', 'Delta: '],
                ['trendItem', 'Trend: '],
                ['elapsedTimeItem', 'Time: ']
            ];
    
            menuItems.forEach(([key, label]) => {
                const item = new PopupMenu.PopupMenuItem(`${label}${LOADING_TEXT}`, {
                    reactive: true,
                    can_focus: true
                });
                this._elements.set(key, item);
                this.menu.addMenuItem(item);
            });
    
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    
           
            const refreshButton = this._createMenuItem('refreshButton', 'Refresh Now', () => {
                this._updateGlucose().catch(error => log('[NightWatcher] Refresh error:', error));
                this.menu.close();
            });
    
           
            const settingsButton = this._createMenuItem('settingsButton', 'Open Settings', () => {
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
                const nsUrl = this._settings.get_string('nightscout-url');
                const nsToken = this._settings.get_string('nightscout-token');
    
                if (!nsUrl || !nsToken) {
                    this._updateErrorState('⚠️ Settings');
                    this._debugLog('Missing URL or token in settings');
                    return;
                }
    
                let baseUrl = nsUrl.replace(/\/$/, '');
                baseUrl = baseUrl.replace(/:443$/, '');
                let cleanToken = nsToken.trim();
                
               
                cleanToken = cleanToken.replace(/^token=/, '');
                cleanToken = cleanToken.replace(/^\?token=/, '');
                cleanToken = cleanToken.replace(/^\/\?token=/, '');
                


                const isMyFritz = baseUrl.includes('myfritz.net');
                if (isMyFritz) {
                    this._debugLog('Detected MyFritz Nightscout installation');
                }


                this._debugLog(`Base URL: ${baseUrl}`);
                this._debugLog(`Original token length: ${nsToken.length}`);
                this._debugLog(`Clean token length: ${cleanToken.length}`);
                this._debugLog(`Token preview: ${cleanToken.substring(0, 8)}...`);
                this._debugLog(`Token has whitespace? ${nsToken !== nsToken.trim()}`);
                this._debugLog(`Token starts with: ${nsToken.substring(0, 10)}`);
                this._debugLog(`Token ends with: ${nsToken.substring(nsToken.length - 5)}`);
                
               
                const authMethods = isMyFritz ? [
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz token query v1 no-count' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/entries.json?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz entries.json' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?count=2&token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz token query param v1' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/entries.json?count=2&token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz simple path with token' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?count=2`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('api-secret', cleanToken);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz api-secret header v1' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/treatments.json?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz treatments endpoint' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/data?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz data endpoint' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/cgm?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz cgm endpoint' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/latest?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz latest endpoint' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/rest/entries?token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'MyFritz REST endpoint' };
                    }
                ] : [
                   
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?count=2`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('api-secret', cleanToken);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'api-secret header v1' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?count=2&token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'token query param v1' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v3/entries.json?count=2`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('api-secret', cleanToken);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'api-secret header v3' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v3/entries.json?count=2&token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'token query param v3' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/api/v1/entries.json?count=2`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Authorization', `Bearer ${cleanToken}`);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'Bearer token v1' };
                    },
                   
                    () => {
                        const url = `${baseUrl}/entries.json?count=2&token=${cleanToken}`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');
                        message.request_headers.append('User-Agent', 'NightWatcher-GNOME-Extension');
                        return { message, url, method: 'simple path with token' };
                    }
                ];

                const ignoreTlsErrors = this._settings.get_boolean('ignore-tls-errors');
                if (ignoreTlsErrors) {
                    this._debugLog('TLS certificate validation will be bypassed');
                }

                const session = new Soup.Session();
                let lastError = null;
                
               
                for (let i = 0; i < authMethods.length; i++) {
                    try {
                        const { message, url, method } = authMethods[i]();
                        this._debugLog(`Trying method ${i + 1}: ${method}`);
                        const sanitizedUrl = url.replace(/token=([^&]+)/, 'token=***REDACTED***');
                        this._debugLog(`URL: ${sanitizedUrl}`);

                        if (ignoreTlsErrors) {
                            message.connect('accept-certificate', () => true);
                        }

                        const bytes = await session.send_and_read_async(
                            message,
                            GLib.PRIORITY_DEFAULT,
                            null
                        );

                        this._debugLog(`Method ${i + 1} returned status: ${message.status_code}`);

                        if (message.status_code === 200) {
                            const decoder = new TextDecoder('utf-8');
                            const text = decoder.decode(bytes.get_data());
                            const data = JSON.parse(text);

                            if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
                                const errorMsg = data.errors[0].message || 'Unknown error';
                                this._debugLog(`Method ${i + 1} returned error: ${errorMsg}`);
                                throw new Error(`Nightscout error: ${errorMsg}`);
                            }

                            this._debugLog(`Successfully authenticated with method ${i + 1} (${method})`);

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
            
                            this._lastReading = current;
                            this._updateMainDisplay(current);
                            this._updateMenuDisplay(current);
                            this._checkAndAlert(current.sgv);
                            
                            return;
                        } else if (message.status_code === 401) {

                            lastError = new Error(`HTTP 401 Unauthorized with method ${i + 1} (${method})`);
                            this._debugLog(`Method ${i + 1} (${method}) failed with 401, trying next...`);
                            continue;
                        } else {
                            this._debugLog(`Method ${i + 1} failed with HTTP ${message.status_code}`);
                            throw new Error(`HTTP error! status: ${message.status_code}`);
                        }
                    } catch (error) {
                        lastError = error;
                        if (i === authMethods.length - 1) {

                            throw error;
                        }
                        this._debugLog(`Method ${i + 1} failed:`, error.message);
                    }
                }
    


                this._debugLog('All authentication methods failed');


                if (isMyFritz) {
                    this._debugLog('MyFritz installation detected but API endpoints not found');
                    this._updateErrorState('🔍 API');
                    return;
                }


                if (this._lastReading) {
                    this._debugLog('Showing cached data');
                    this._updateMainDisplay(this._lastReading);
                    this._updateMenuDisplay(this._lastReading);
                    return;
                }
                
                throw lastError || new Error('All authentication methods failed');
    
            } catch (error) {
                console.log('[NightWatcher] Error:', error);
                if (!this._isDestroyed) {
                   
                    let errorMessage = ERROR_TEXT;
                    if (error.message.includes('HTTP 401') || error.message.includes('Unauthorized')) {
                        errorMessage = '🔐 Auth';
                    } else if (error.message.includes('HTTP')) {
                        errorMessage = '🌐 HTTP';
                    } else if (error.message.includes('Not enough glucose data')) {
                        errorMessage = '📊 Data';
                    }
                    
                    this._updateErrorState(errorMessage);
                }
            }
        }

        _playAlert() {
            if (this._isDestroyed) return;

            this._debugLog('Starting alert playback...');
            try {
                const soundPath = GLib.build_filenamev([this._extension.path, 'sounds', 'alert.mp3']);
                if (!GLib.file_test(soundPath, GLib.FileTest.EXISTS)) {
                    console.log('[NightWatcher] Alert sound file not found:', soundPath);
                    return;
                }

                try {
                    const player = global.display.get_sound_player();
                    const file = Gio.File.new_for_path(soundPath);
                    player.play_from_file(file, 'NightWatcher Alert', null);
                    this._debugLog('Alert playback started');
                    this._lastAlertTime = Date.now();
                } catch (error) {
                    console.log('[NightWatcher] Error playing alert:', error);
                }
            } catch (error) {
                console.log('[NightWatcher] Alert playback failed:', error);
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
        
            } catch (error) {
                console.log('[NightWatcher] Error updating menu display:', error);
            }
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
    
            this._isDestroyed = true;
    
            if (this._timeout) {
                GLib.source_remove(this._timeout);
                this._timeout = null;
            }
    
            if (this._settingsChangedId) {
                try {
                    this._settings.disconnect(this._settingsChangedId);
                } catch (error) {
                    console.log('[NightWatcher] Error disconnecting settings:', error);
                }
                this._settingsChangedId = null;
            }

            if (this.boxLayout) {
                this.boxLayout.get_children().forEach(child => {
                    try {
                        this.boxLayout.remove_child(child);
                    } catch (error) {
                        console.log('[NightWatcher] Error removing child:', error);
                    }
                });
            }
    
            this._elements.clear();
            super.destroy();
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