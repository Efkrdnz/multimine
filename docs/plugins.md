# Writing a Multimine plugin

A plugin adds a tool to Multimine's **Tools** grid: a window with your own page in it, and
optionally tools your agents can call. It is a folder:

```
my-tool/
  plugin.json     the manifest
  index.html      the page the tool window shows
  icon.png        optional
  server.js       optional: an MCP server giving agents tools
```

Install it from the Tools grid (**Install**, choose the folder), or drop it into a project's
`.multimine/plugins/` (project plugins never run until the user enables them). The smallest working
example is [`examples/plugins/hello`](../examples/plugins/hello).

## plugin.json

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "api": 1,
  "description": "One sentence for the Tools grid and the consent dialog.",
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
| `api` | The plugin API version you wrote against. This Multimine speaks `1`. |
| `icon` | A [lucide](https://lucide.dev/icons) icon name and two hex colours, or `{ "file": "icon.png" }`. |
| `entry` | Your page, relative to the folder. |
| `window` | The tool window's starting size. |
| `permissions` | What you need (below). The user sees each one and can refuse or later revoke it. |
| `mcp` | Optional MCP server; `${PLUGIN_DIR}` becomes your folder. It appears under Settings -> MCP servers as "My Tool (plugin)" and the user ticks which agents get it. |

## Permissions

| Permission | Allows |
|---|---|
| `team:read` | `team.list()` |
| `agents:message` | `send(to, text)` |
| `project:read` | `files.list`, `files.read` |
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
  const info = await multimine.info()                 // { pluginId, apiVersion, project }
  const team = await multimine.team.list()            // [{ id, name, role, provider, model }]
  await multimine.send('mastermind', 'Hello!')         // shows on the bus and in Mastermind's chat
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

## Security model

- Your page runs in a sandboxed frame on its own `mmplugin://<id>` origin. It cannot reach
  Multimine's memory, its IPC, the user's API keys, subscriptions or settings.
- Its content policy allows scripts, styles and assets from your folder (and the SDK) only; no
  network unless the user granted `network`; no nested frames.
- Every API call is checked in the main process against what the user granted, at the moment of the
  call, so a revoke takes effect immediately.
- An MCP server runs as a normal local process (like any MCP server the user adds); its tools reach
  only the agents the user assigns it to.
