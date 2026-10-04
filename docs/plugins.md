# Writing a Multimine plugin

A plugin adds a tool to Multimine's sidebar: a window with your own page in it, and optionally
tools your chats can call. It is a folder:

```
my-tool/
  plugin.json     the manifest
  index.html      the page the tool window shows
  icon.png        optional
  server.js       optional: an MCP server giving chats tools
```

Install it from **Tools -> Manage** (the grid button by "Tools" in the sidebar) with **Install a
plugin**, or drop it into a project's `.multimine/plugins/` (project plugins never run until the
user enables them). The smallest working example is
[`examples/plugins/hello`](../examples/plugins/hello).

## plugin.json

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "api": 2,
  "description": "One sentence for the sidebar and the consent dialog.",
  "icon": { "glyph": "Sparkles", "gradient": ["#f472b6", "#8b5cf6"] },
  "entry": "index.html",
  "window": { "width": 900, "height": 640 },
  "permissions": ["team:read", "agents:message"],
  "mcp": { "command": "node", "args": ["${PLUGIN_DIR}/server.js"], "env": {} }
}
```

| Field | |
|---|---|
| `id` | 2-40 lowercase letters, digits, dashes. Unique. |
| `api` | The plugin API version you wrote against. This Multimine speaks `2`, and still runs `1` plugins. |
| `icon` | A [lucide](https://lucide.dev/icons) icon name and two hex colours, or `{ "file": "icon.png" }`. |
| `entry` | Your page, relative to the folder. |
| `window` | The tool window's starting size. |
| `permissions` | What you need (below). The user sees each one and can refuse or later revoke it. |
| `mcp` | Optional MCP server; `${PLUGIN_DIR}` becomes your folder. It appears under Settings -> MCP servers as "My Tool (plugin)" and the user switches it on for the chats that should have it. |

## Permissions

| Permission | Allows |
|---|---|
| `team:read` | `chats.list()` (the name is kept from API 1, so granted plugins are not asked again) |
| `agents:message` | `send(to, text, options)`, `task(to, title, text, options)` |
| `project:read` | `files.list`, `files.read`, `ide.open(path, line)` |
| `project:write` | `files.write` |
| `media:read` | `media.list()` |
| `media:write` | `media.show()` |
| `network` | your page may make HTTPS requests and load remote images, fonts and styles |

Ask for the least you need: the consent dialog lists them in plain words.

## The API

Include the SDK and use `window.multimine`; every call returns a promise and fails with a clear
message when a permission is missing.

```html
<script src="mmplugin://sdk/multimine.js"></script>
<script>
  const info = await multimine.info()                 // { pluginId, apiVersion: 2, project }
  const chats = await multimine.chats.list()          // [{ id, name, provider, model, mcp, busy, active }]
  const { chatId } = await multimine.send('active', 'Hello!')  // to the chat on screen
  await multimine.send('new', '# Tidy the build\n\nDetails...') // starts a chat named after the first line
  await multimine.send(chatId, 'And one more thing')            // continues that chat's conversation
  await multimine.task('new', 'Build the inventory', 'the brief', { planMode: true })
  const text = await multimine.files.read('README.md') // 'base64' as a second argument for binary
  await multimine.files.write('notes/todo.md', '# Todo')
  await multimine.media.show('data:image/png;base64,...', 'Preview')
  await multimine.storage.set('last', { x: 1 })        // your own store, no permission needed
  await multimine.ui.toast('Done')
  await multimine.ui.setTitle('My Tool - draft 2')
  await multimine.ui.close()
</script>
```

Paths are relative to the open project and can never leave it.

### Sending to a chat

`to` is a chat id from `chats.list()`, `'active'` (the chat on screen) or `'new'`. A message shows in
the chat as coming from your tool ("from My Tool") and runs like anything the user types there, on
that chat's provider and with its permissions. Both calls resolve to `{ chatId }`: keep it to send
follow-ups to the same conversation.

- `task(to, title, text)` is `send` with the title as the message's first line (`# title`).
- A new chat is named after the first line of the message: `My Tool: Build the inventory`.
- `options` apply only to a chat the call starts:
  - `mcp`: MCP server ids it starts with switched on - only servers the user has set up in Settings
    count, anything else is ignored. The Asset Board uses this to start a chat with its image and 3D
    generators.
  - `planMode: true`: it plans first and asks the user to approve before changing anything (Claude
    chats; other providers ignore it).

Pick a sensible default and let the user choose: the built-in tools default to a new chat for a
build (so a long job does not clutter the conversation on screen) and send follow-ups back to the
chat that did the first one.

### API 1

Plugins written for API 1 keep working:

- `team.list()` lists the chats, each as `{ id, name, role: 'custom', provider, model }`.
- `send('mastermind', ...)` and `task('mastermind', ...)` go to the chat on screen.
- `task` no longer returns an approval id (`approvalId` is always `null`): there is no approval gate
  to open.

## Security model

- Your page runs in a sandboxed frame on its own `mmplugin://<id>` origin. It cannot reach
  Multimine's memory, its IPC, the user's API keys, subscriptions or settings.
- Its content policy allows scripts, styles and assets from your folder (and the SDK) only; no
  network unless the user granted `network`; no nested frames.
- Every API call is checked in the main process against what the user granted, at the moment of the
  call, so a revoke takes effect immediately.
- A chat your plugin messages runs with that chat's own permissions: Supervised chats still ask the
  user before every edit and command, and pushing or deleting work always asks.
- An MCP server runs as a normal local process (like any MCP server the user adds); its tools reach
  only the chats the user switches it on for.

## The built-in tools

The UI Sketcher (`ui-sketcher`), the Asset Board (`asset-board`), Data Tables (`data-tables`) and the
Logic Board (`logic-board`) ship with Multimine and are drawn as part of the app, but they hold no
privileges of their own: each is listed as a plugin, its permissions can be revoked in **Manage**
like any other, and every file it writes, message it sends and picture it shows goes through the
same `pluginCall` handlers your plugin's `window.multimine` reaches. Anything they do, a plugin can do.
