// SPDX-License-Identifier: GPL-2.0-or-later
// Window Share Filter: a filter prompt in front of the screen-share window picker.
//
// The picker (xdg-desktop-portal-gnome) gets its window list from GNOME Shell
// through org.gnome.Shell.Introspect.GetWindows, and only the portal is allowed
// to call it. This extension wraps that call on the running service and lets
// the original implementation build the list with the filter added to its
// per-window eligibility check.
//
// When the portal calls (xdg-desktop-portal-gnome, src/screencastwidget.c and
// src/shellintrospect.c, read 2026-10-30): once when its share dialog is built,
// then again after every WindowsChanged signal until the dialog is destroyed,
// which happens only when the share session ends. The call is synchronous, and
// the portal gives up after the D-Bus default of 25 seconds.
//
// So the extension never makes the portal wait. For a new share it answers at
// once with every window and opens the prompt. When a filter is chosen, it
// emits WindowsChanged; the portal asks again and gets the filtered list.
// Each call is classified:
//   - the prompt is open: answer with every window, the filter comes later;
//   - a filter was chosen less than CHOSEN_SECONDS ago, a portal window is
//     open, or one closed less than GRACE_SECONDS ago: a refresh of the open
//     picker; reuse the chosen filter;
//   - a screen share is running, or stopped less than GRACE_SECONDS ago: a
//     refresh behind a share; the list is not shown to anyone, so answer with
//     every window;
//   - otherwise: a new share; answer with every window and prompt.
// The prompt applies what has been chosen after PROMPT_SECONDS.
//
// When an app restores an earlier window share, the portal fetches the list
// without showing its picker. The restore goes ahead with the full list, and
// the prompt that opens with it can be dismissed with Esc.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PORTAL_COMM = 'xdg-desktop-por';  // /proc/<pid>/comm, cut to 15 characters
const PROMPT_SECONDS = 60;
const GRACE_SECONDS = 3;
const CHOSEN_SECONDS = 10;

// A switched-on toggle in the prompt: outlined and tinted.
const CHECKED_STYLE = 'border: 2px solid #3584e4; background-color: rgba(53, 132, 228, 0.35);';

const ALL = {apps: [], terms: [], workspaceOnly: false};

function now() {
    return GLib.get_monotonic_time() / 1e6;
}

function appOf(window) {
    return Shell.WindowTracker.get_default().get_window_app(window);
}

function appName(window) {
    return appOf(window)?.get_name() ?? window.get_wm_class() ?? '';
}

// St's default button style barely shows the checked state.
function markChecked(button) {
    button.connect('notify::checked', () => button.set_style(button.checked ? CHECKED_STYLE : null));
}

function isPortalWindow(window) {
    const pid = window.get_pid();
    if (pid <= 0)
        return false;
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
        return new TextDecoder().decode(bytes).trim() === PORTAL_COMM;
    } catch (e) {
        return false;
    }
}

// A window matches when it belongs to one of the chosen apps (any app when none
// is chosen), its title contains every term, and, with workspaceOnly, it is on
// the active workspace.
function matches(filter, window) {
    if (filter.apps.length && !filter.apps.includes(appName(window)))
        return false;
    if (filter.workspaceOnly) {
        const ws = global.workspace_manager.get_active_workspace();
        if (!window.located_on_workspace(ws))
            return false;
    }
    const title = (window.get_title() ?? '').toLowerCase();
    return filter.terms.every(t => title.includes(t));
}

const FilterDialog = class {
    constructor(windows, onDone) {
        this._windows = windows;
        this._onDone = onDone;
        this._workspaceOnly = false;
        this._apps = new Set();
        this._finished = false;
        this._destroyed = false;
        this._left = PROMPT_SECONDS;

        this._dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 12px; min-width: 40em;',
        });
        this._dialog.contentLayout.add_child(box);

        box.add_child(new St.Label({
            text: 'Which windows should the share picker offer?',
            style: 'font-weight: bold;',
        }));

        // One toggle per application that has a window to share, in two columns
        // of equal width. None checked means any application.
        box.add_child(new St.Label({text: 'Application (none checked = any):'}));
        const grid = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 6, row_spacing: 6});
        const apps = new St.Widget({layout_manager: grid, x_expand: true});
        const names = [...new Set(windows.map(appName).filter(n => n))].sort();
        names.forEach((name, i) => {
            const b = new St.Button({
                label: name, style_class: 'button', toggle_mode: true, can_focus: true, x_expand: true,
            });
            markChecked(b);
            b.connect('clicked', () => {
                if (b.checked)
                    this._apps.add(name);
                else
                    this._apps.delete(name);
                this._update();
                this._entry.grab_key_focus();
            });
            grid.attach(b, i % 2, Math.floor(i / 2), 1, 1);
        });
        box.add_child(apps);

        box.add_child(new St.Label({text: 'Title contains:'}));
        this._entry = new St.Entry({hint_text: 'e.g. slides, mkfit', can_focus: true});
        this._entry.clutter_text.connect('text-changed', () => this._update());
        this._entry.clutter_text.connect('activate', () => this._finish(this._filter()));
        box.add_child(this._entry);

        this._wsButton = new St.Button({style_class: 'button', toggle_mode: true, can_focus: true});
        markChecked(this._wsButton);
        this._wsButton.connect('clicked', () => {
            this._workspaceOnly = this._wsButton.checked;
            this._update();
            this._entry.grab_key_focus();
        });
        box.add_child(this._wsButton);

        this._count = new St.Label();
        box.add_child(this._count);

        this._dialog.setButtons([
            {label: 'All windows', action: () => this._finish(ALL), key: Clutter.KEY_Escape},
            {label: 'Filter', action: () => this._finish(this._filter()), default: true},
        ]);
        this._dialog.setInitialKeyFocus(this._entry);
        this._dialog.connect('destroy', () => {
            this._destroyed = true;
            this._finish(ALL);
        });

        // Count down once a second; at zero, apply what has been chosen.
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (--this._left > 0) {
                this._update();
                return GLib.SOURCE_CONTINUE;
            }
            this._timeout = 0;
            this._finish(this._filter());
            return GLib.SOURCE_REMOVE;
        });
        this._update();

        // open() fails when another modal grab is active; do not keep the portal waiting.
        if (this._dialog.open() === false)
            this._finish(ALL);
    }

    _filter() {
        const terms = this._entry.get_text().toLowerCase().split(/\s+/).filter(t => t);
        return {apps: [...this._apps], terms, workspaceOnly: this._workspaceOnly};
    }

    _update() {
        this._wsButton.label = `Current workspace only: ${this._workspaceOnly ? 'on' : 'off'}`;
        const f = this._filter();
        const n = this._windows.filter(w => matches(f, w)).length;
        this._count.text = `${n} of ${this._windows.length} windows match (applies itself in ${this._left} s)`;
    }

    _finish(filter) {
        if (this._finished)
            return;
        this._finished = true;
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._onDone(filter);
        if (!this._destroyed)
            this._dialog.close();
    }

    cancel() {
        this._finish(ALL);
    }

    get finished() {
        return this._finished;
    }
};

export default class ShareFilterExtension extends Extension {
    enable() {
        const service = Main.introspectService;
        const ext = this;
        this._lastFilter = ALL;
        this._chosenAt = -Infinity;
        this._dialog = null;
        this._queue = Promise.resolve();

        // Portal windows: the picker is open while one is.
        this._portalWindows = new Map();
        this._portalClosedAt = -Infinity;
        this._createdId = global.display.connect('window-created', (d, w) => this._watchWindow(w));
        global.display.list_all_windows().forEach(w => this._watchWindow(w));

        // Running screen shares, as the Shell's own sharing indicator tracks them.
        this._shares = new Map();
        this._shareStoppedAt = -Infinity;
        this._controller = global.backend.get_remote_access_controller();
        this._handleId = this._controller?.connect('new-handle', (c, h) => this._watchShare(h));

        // An own property shadows the class method; disable() deletes it again.
        // Calls run one at a time, because the filter is put in place around an await.
        this._original = service.GetWindowsAsync;
        service.GetWindowsAsync = function (params, invocation) {
            const run = ext._queue.then(() => ext._getWindows(this, params, invocation));
            ext._queue = run.catch(() => {});
            return run;
        };
    }

    disable() {
        this._dialog?.cancel();
        this._dialog = null;
        delete Main.introspectService.GetWindowsAsync;
        this._original = null;

        global.display.disconnect(this._createdId);
        for (const [w, id] of this._portalWindows)
            w.disconnect(id);
        this._portalWindows = null;

        if (this._handleId)
            this._controller.disconnect(this._handleId);
        for (const [h, id] of this._shares)
            h.disconnect(id);
        this._shares = null;
        this._controller = null;
    }

    async _getWindows(service, params, invocation) {
        try {
            await service._senderChecker.checkInvocation(invocation);
        } catch (e) {
            // Not the portal: let the original refuse it, without a prompt.
            return this._original.call(service, params, invocation);
        }

        const filter = this._getFilter(service);
        const eligible = service._isEligibleWindow;
        service._isEligibleWindow = w => eligible.call(service, w) && matches(filter, w);
        try {
            return await this._original.call(service, params, invocation);
        } finally {
            delete service._isEligibleWindow;
        }
    }

    _watchWindow(window) {
        if (!isPortalWindow(window))
            return;
        const id = window.connect('unmanaged', () => {
            this._portalWindows?.delete(window);
            this._portalClosedAt = now();
        });
        this._portalWindows.set(window, id);
    }

    _watchShare(handle) {
        if (handle.is_recording)
            return;
        const id = handle.connect('stopped', () => {
            this._shares?.delete(handle);
            this._shareStoppedAt = now();
        });
        this._shares.set(handle, id);
    }

    // Returns the filter for this call at once; never waits for the prompt.
    _getFilter(service) {
        const t = now();
        if (this._dialog)
            return ALL;
        if (t - this._chosenAt < CHOSEN_SECONDS || this._portalWindows.size ||
            t - this._portalClosedAt < GRACE_SECONDS)
            return this._lastFilter;
        if (this._shares.size || t - this._shareStoppedAt < GRACE_SECONDS)
            return ALL;

        const windows = global.display.list_all_windows()
            .filter(w => service._isEligibleWindow(w) && appOf(w));
        // The callback can run inside the constructor (when the dialog cannot
        // open), so the dialog is kept only if it is still waiting for an answer.
        // It runs from an idle callback, so this call has returned its answer
        // before the portal is asked to fetch the filtered list.
        let dialog = null;
        dialog = new FilterDialog(windows, filter => {
            if (this._dialog === dialog)
                this._dialog = null;
            this._lastFilter = filter;
            this._chosenAt = now();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                service._dbusImpl.emit_signal('WindowsChanged', null);
                return GLib.SOURCE_REMOVE;
            });
        });
        if (!dialog.finished)
            this._dialog = dialog;
        return ALL;
    }
}
