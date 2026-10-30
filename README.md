# Window Share Filter

A GNOME Shell extension for the screen-share window picker.

When an app asks to share a window (Zoom, Google Meet or Teams in a browser,
OBS), GNOME's picker lists every window on every workspace, with no search.
With many windows open, the one you want is hard to find. This extension asks
first, in a small prompt:

- **Application:** one toggle per application that has a window open. Pick one
  or several; none picked means any application.
- **Title contains:** words that must all appear in the window title, in any
  order, ignoring case.
- **Current workspace only.**

The picker then offers only the matching windows. Esc, or "All windows", skips
the filter. Without an answer, the prompt applies what has been chosen after 60
seconds.

Sharing a whole screen is not affected.

## Install

Requires GNOME Shell 50.

```
git clone https://github.com/osschar/gnome-window-share-filter.git \
    ~/.local/share/gnome-shell/extensions/window-share-filter@osschar.github.io
gnome-extensions enable window-share-filter@osschar.github.io
```

On Wayland, GNOME Shell loads a new or changed extension only at login, so log
out and back in. If `gnome-extensions enable` reports that the extension does
not exist, it has not been loaded yet. Enable it after the login, or add it to
`org.gnome.shell enabled-extensions` with `gsettings` before.

## How it works

The picker belongs to `xdg-desktop-portal-gnome`, a separate program, so an
extension cannot change it. The picker gets its window list from GNOME Shell,
through the D-Bus method `org.gnome.Shell.Introspect.GetWindows`, which only the
portal is allowed to call. The extension wraps that method on the running
service.

The portal calls the method once when it builds the picker, and again every
time GNOME Shell announces a change to the window list, until the share session
ends. The call is synchronous, and the portal gives up after the D-Bus default
of 25 seconds. So the extension never makes the portal wait. For a new share it
answers at once with every window and opens the prompt. When a filter is
chosen, it emits `WindowsChanged`, and the portal fetches the filtered list.
While the picker is open, its refreshes get the same filter. Behind a running
share, the list is not shown to anyone, and the extension answers without
prompting.

The header comment of `extension.js` has the exact rules.

## Known limitation

When an app restores an earlier window share without showing the picker, the
portal still fetches the window list, and the prompt opens on its own. The
restore goes ahead with the full list, and Esc closes the prompt.

## License

GPL-2.0-or-later. See `LICENSE`.
