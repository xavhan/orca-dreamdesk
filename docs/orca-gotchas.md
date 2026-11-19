# Orca plugin gotchas

These are platform behaviours that DreamDesk relies on or works around. Every one of them was found the hard way: the plugin tests pass and the real panel still breaks. Confirm a panel change with `orca plugin shot`.

## Panel runtime

- **Panels cannot load `node:` modules.** A panel that imports a file which imports `node:fs` fails with "Failed to fetch dynamically imported module". Tests run in Node, so they will not catch it. Keep anything the panel imports in pure modules (`queue.ts`, `calendar.ts`, `protocol.ts`).
- **Panels have no network and no hover.** Only `Button` and `IconButton` take a `tooltip`. Hover-like detail is done with an `IconButton` tooltip or a `Collapsible` that opens on click.
- **There is no animation and there are no custom colours.** `Spinner` and `Progress` are the only moving or filled elements that render clearly. In the user's theme, `Box background` tones and the `tone` of a solid `Button` are faint or grey. The day bar is built from several `Progress` bars for that reason.

## Images

- `Image src` must be a **PNG file inside the plugin folder**, given as a relative path such as `assets/x.png`. SVG, `data:` URIs and URLs are refused.
- PNGs rendered by `qlmanage` get an opaque white background. Use `rsvg-convert -b none` to keep transparency.
- `Image size="xs"` is about 48px. To get a smaller image, put it in a fixed `<Box width={16} height={16}>` with `size="full"`. The `Icon` helper in `panel.tsx` does this.
- Orca caches images by path. To replace an asset, give it a new filename.
- New files in `assets/` only showed up after `orca plugin dev unload` followed by `dev load`. Files the worker downloads into `avatars/` and `media/` at runtime do show up. Both folders are gitignored.

## Layout

- `Box width` accepts a number or a **whole** percentage. `"55.5%"` is silently ignored, so round it (see `whole()` in `panel.tsx`).
- To let a truncated `Text` shrink inside a row, give its wrapper `Box grow minWidth={0}`.

## Worker

- `orca.storage.set` refuses `undefined` fields. `commit()` round-trips the queue through JSON before storing it.
- A worker with `statusBarItems` stays alive, so plain `setInterval` timers are fine. Do not `unref()` them, or the timers stop.
- Changing the capabilities, commands or settings in the manifest needs a new approval: `orca plugin dev load .`, then `--approve <fingerprint>`. During a reload, host calls can fail with "plugin is not enabled with current consent". The worker therefore reads secrets lazily and retries every minute instead of giving up at start. If it persists, run `orca plugin restart <plugin-key>`.
- `agents.list` gives a more precise state than the workspace status from `workspace.list`. Use it for worktree state.
