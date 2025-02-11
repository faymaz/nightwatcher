// prefs.js
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NightWatcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create pages with icons
        const pages = [
            {
                id: 'account',
                title: 'Account',
                iconName: 'user-info-symbolic',
                creator: this._createAccountPage.bind(this)
            },
            {
                id: 'thresholds',
                title: 'Thresholds',
                iconName: 'preferences-system-symbolic',
                creator: this._createThresholdsPage.bind(this)
            },
            {
                id: 'alerts',
                title: 'Alerts',
                iconName: 'preferences-system-notifications-symbolic',
                creator: this._createAlertsPage.bind(this)
            },
            {
                id: 'display',
                title: 'Display',
                iconName: 'preferences-desktop-display-symbolic',
                creator: this._createDisplayPage.bind(this)
            }
        ];

        // Create and add pages
        pages.forEach(({ id, title, iconName, creator }) => {
            const page = creator(settings);
            page.set_title(title);
            page.set_icon_name(iconName);
            window.add(page);
        });
    }

    _createAccountPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'NightWatcher Settings',
            description: 'Configure your Nightscout connection'
        });

        // URL
        const urlRow = new Adw.ActionRow({
            title: 'Nightscout URL',
            subtitle: 'Your Nightscout site URL (without trailing slash)'
        });
        const urlEntry = new Gtk.Entry({
            text: settings.get_string('nightscout-url'),
            valign: Gtk.Align.CENTER,
            hexpand: true
        });
        urlEntry.connect('changed', (entry) => {
            settings.set_string('nightscout-url', entry.get_text());
        });
        urlRow.add_suffix(urlEntry);
        group.add(urlRow);

        // Token
        const tokenRow = new Adw.ActionRow({
            title: 'API Token',
            subtitle: 'Your Nightscout API token'
        });
        const tokenEntry = new Gtk.Entry({
            text: settings.get_string('nightscout-token'),
            valign: Gtk.Align.CENTER,
            visibility: false,
            hexpand: true
        });
        tokenEntry.connect('changed', (entry) => {
            settings.set_string('nightscout-token', entry.get_text());
        });
        tokenRow.add_suffix(tokenEntry);
        group.add(tokenRow);

        page.add(group);
        return page;
    }

    _createThresholdsPage(settings) {
        const page = new Adw.PreferencesPage();
        
        // Thresholds Group
        const thresholdsGroup = new Adw.PreferencesGroup({
            title: 'Glucose Thresholds',
            description: 'Set glucose threshold values (mg/dL)'
        });
        
        // Create threshold rows
        const thresholds = [
            ['urgent-high-threshold', 'Urgent High Threshold', 'Value for urgent high alerts'],
            ['high-threshold', 'High Threshold', 'Value for high alerts'],
            ['low-threshold', 'Low Threshold', 'Value for low alerts'],
            ['urgent-low-threshold', 'Urgent Low Threshold', 'Value for urgent low alerts']
        ];

        thresholds.forEach(([key, title, subtitle]) => {
            const row = this._createSpinRow(settings, key, title, subtitle, 40, 400);
            thresholdsGroup.add(row);
        });

        page.add(thresholdsGroup);

        // Colors Group
        const colorsGroup = new Adw.PreferencesGroup({
            title: 'Threshold Colors',
            description: 'Customize colors for different glucose ranges'
        });

        // Create color rows
        const colors = [
            ['urgent-high-color', 'Urgent High Color'],
            ['high-color', 'High Color'],
            ['normal-color', 'Normal Color'],
            ['low-color', 'Low Color'],
            ['urgent-low-color', 'Urgent Low Color']
        ];

        colors.forEach(([key, title]) => {
            const row = this._createColorRow(settings, key, title);
            colorsGroup.add(row);
        });

        page.add(colorsGroup);
        return page;
    }

    _createAlertsPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Alert Settings',
            description: 'Configure sound alerts for glucose levels'
        });

        // Enable Alerts
        const enableRow = new Adw.ActionRow({
            title: 'Enable Alerts',
            subtitle: 'Enable sound alerts for urgent glucose levels'
        });
        const enableSwitch = new Gtk.Switch({
            active: settings.get_boolean('enable-alerts'),
            valign: Gtk.Align.CENTER
        });
        enableSwitch.connect('notify::active', (widget) => {
            settings.set_boolean('enable-alerts', widget.get_active());
        });
        enableRow.add_suffix(enableSwitch);
        group.add(enableRow);

        // Create alert switches
        const alerts = [
            ['alert-urgent-high', 'Alert on Urgent High', 'Play alert sound when glucose is urgent high'],
            ['alert-urgent-low', 'Alert on Urgent Low', 'Play alert sound when glucose is urgent low']
        ];

        alerts.forEach(([key, title, subtitle]) => {
            const row = new Adw.ActionRow({
                title: title,
                subtitle: subtitle
            });
            const switchWidget = new Gtk.Switch({
                active: settings.get_boolean(key),
                valign: Gtk.Align.CENTER
            });
            switchWidget.connect('notify::active', (widget) => {
                settings.set_boolean(key, widget.get_active());
            });
            row.add_suffix(switchWidget);
            group.add(row);
        });

        // Alert Interval
        const intervalRow = new Adw.ActionRow({
            title: 'Alert Interval',
            subtitle: 'Minimum time between alerts (in minutes)'
        });
        const intervalSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1
            }),
            value: settings.get_int('alert-interval') / 60,
            valign: Gtk.Align.CENTER
        });
        intervalSpin.connect('value-changed', (widget) => {
            settings.set_int('alert-interval', widget.get_value() * 60);
        });
        intervalRow.add_suffix(intervalSpin);
        group.add(intervalRow);

        page.add(group);
        return page;
    }

    _createDisplayPage(settings) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Display Settings',
            description: 'Configure what information to show in the panel'
        });

        // Create display switches
        const displays = [
            ['show-delta', 'Show Delta', 'Show glucose value change in the panel'],
            ['show-trend', 'Show Trend Arrow', 'Show trend arrow in the panel'],
            ['show-time', 'Show Elapsed Time', 'Show elapsed time since last reading in the panel'],
            ['show-icon', 'Show Icon', 'Show NightWatcher icon in the panel']
        ];

        displays.forEach(([key, title, subtitle]) => {
            const row = new Adw.ActionRow({
                title: title,
                subtitle: subtitle
            });
            const switchWidget = new Gtk.Switch({
                active: settings.get_boolean(key),
                valign: Gtk.Align.CENTER
            });
            switchWidget.connect('notify::active', (widget) => {
                settings.set_boolean(key, widget.get_active());
            });
            row.add_suffix(switchWidget);
            group.add(row);
        });

        // Icon Position dropdown
        const positionRow = new Adw.ActionRow({
            title: 'Icon Position',
            subtitle: 'Position of the icon in panel'
        });
        const positionCombo = new Gtk.ComboBoxText({
            valign: Gtk.Align.CENTER
        });
        positionCombo.append('left', 'Left');
        positionCombo.append('right', 'Right');
        positionCombo.set_active_id(settings.get_string('icon-position'));
        positionCombo.connect('changed', (widget) => {
            settings.set_string('icon-position', widget.get_active_id());
        });
        positionRow.add_suffix(positionCombo);
        group.add(positionRow);

        page.add(group);
        return page;
    }

    _createSpinRow(settings, key, title, subtitle, min, max) {
        const row = new Adw.ActionRow({
            title: title,
            subtitle: subtitle
        });

        const spinButton = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1
            }),
            value: settings.get_int(key),
            valign: Gtk.Align.CENTER,
            digits: 0
        });

        spinButton.connect('value-changed', (widget) => {
            settings.set_int(key, widget.get_value());
        });

        row.add_suffix(spinButton);
        return row;
    }

    _createColorRow(settings, key, title) {
        const row = new Adw.ActionRow({
            title: title
        });

        const colorButton = new Gtk.ColorButton({
            valign: Gtk.Align.CENTER,
            use_alpha: false
        });

        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string(key));
        colorButton.set_rgba(rgba);

        colorButton.connect('color-set', (widget) => {
            const color = widget.get_rgba().to_string();
            settings.set_string(key, color);
        });

        row.add_suffix(colorButton);
        return row;
    }
}