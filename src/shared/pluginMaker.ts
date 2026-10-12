/**
 * Making a tool with a chat: `/plugin <what it should do>` (or the Make a tool dialog) has a chat
 * write a Multimine plugin into the project's `.multimine/tool-drafts/<id>/`, following the plugin
 * guide, and install it with the install_plugin tool, which checks it first.
 */

/** Where a chat writes the tools it makes, relative to the project. */
export const DRAFTS = '.multimine/tool-drafts'

export interface MakeRequest {
  /** What the tool should do, in the user's words. */
  request: string
  /** Set when changing a tool that exists: its id and name. */
  editing?: { id: string; name: string }
}

/** Reads `/plugin ...`: a new tool, or `/plugin change <id>: ...` for one that exists. */
export function parsePluginCommand(body: string, name: (id: string) => string | undefined): MakeRequest {
  const rest = body.trimStart().replace(/^\/plugin\s*/, '')
  const change = /^change\s+([a-z0-9][a-z0-9-]{1,39})\s*:\s*([\s\S]*)$/.exec(rest)
  if (change) return { request: change[2].trim(), editing: { id: change[1], name: name(change[1]) ?? change[1] } }
  return { request: rest.trim() }
}

/** The body a chat is sent to make (or change) a tool. */
export function pluginCommand(request: string, editId?: string): string {
  return editId ? `/plugin change ${editId}: ${request.trim()}` : `/plugin ${request.trim()}`
}

/** A tool's chat is named after what it makes. */
export function pluginChatName(body: string): string {
  const r = body.trimStart().replace(/^\/plugin\s*/, '')
  const change = /^change\s+([a-z0-9-]+)\s*:\s*(.*)/s.exec(r)
  return change ? `Tool: change ${change[1]}` : `Tool: ${r.split('\n')[0]}`
}

const LOOK = `- It opens in Multimine's dark window. Match it: a transparent page background (the window behind it is #0b0d1f), text #e5e7ff, muted text #a5b4fc, lines rgba(165,180,252,0.14), inputs on #0b0d22 with a 1px #333a70 border and 8px corners, primary buttons as a #7c3aed to #4f46e5 gradient with white text, font system-ui at 13-14px. Lay it out for the window size you declare.`

/** The prompt for a turn that makes or changes a tool. */
export function pluginMakerPrompt(r: MakeRequest, taken: string[], guide: string): string {
  const where = r.editing ? `${DRAFTS}/${r.editing.id}/` : `${DRAFTS}/<id>/`
  const task = r.editing
    ? [
        `# Change the tool "${r.editing.name}"`,
        '',
        `Its files are in \`${where}\`. Read them first, make this change, raise the version in plugin.json, and install it again:`,
        '',
        r.request
      ]
    : ['# Make a Multimine tool', '', 'The user wants a tool (a Multimine plugin) that does this:', '', r.request]
  return [
    ...task,
    '',
    '## Where',
    r.editing
      ? `Keep the id "${r.editing.id}" and the folder \`${where}\`.`
      : `Write every file in \`${where}\` (relative to the project root), where <id> is the plugin id you choose: 2-40 lowercase letters, digits or dashes, the same in plugin.json and the folder name, and none of: ${taken.join(', ') || '(none taken)'}.`,
    'plugin.json and the page (index.html) go there; add app.js, style.css or an icon only if they help. Write nothing for the tool anywhere else.',
    '',
    '## How to build it',
    '- One page, no build step and no npm packages: plain HTML, CSS and JavaScript. Use `<script type="module">` (or a module file) so you can use top-level await. Load the SDK first: `<script src="mmplugin://sdk/multimine.js"></script>`.',
    '- Ask for exactly the permissions the code uses, no more. Every multimine call fails with a clear message when its permission was not granted: catch it and show it in the page.',
    "- Keep the tool's own state (settings, drafts, history) with multimine.storage, which needs no permission. Use project files only for what belongs to the project, in the place the user would expect, and never remove files the tool did not create.",
    '- Scripts and styles come from its own folder or inline. No CDNs and no remote files unless it truly needs the internet, and then ask for "network".',
    LOOK,
    '- Pick an icon: a lucide icon name (lucide.dev/icons) and two hex colours that suit it.',
    '- Add an MCP server (tools for chats) only if the user asked for something chats can call.',
    '- If it sends work to a chat, let the user pick which (a new chat or one from multimine.chats.list) and keep the chatId for follow-ups.',
    '',
    '## Install it',
    `When the files are written, call install_plugin with the id. It checks the manifest and files, that every permission the code uses is asked for, that the scripts parse, and loads the page once to catch errors. If it reports problems, fix them and call it again until it installs. Once it is installed the user is asked to allow its permissions and the tool opens beside the chat.`,
    'Finish with two or three sentences: what the tool does, how to use it, and that it is under Tools in the sidebar (and can be changed by asking again).',
    '',
    '# The plugin guide',
    '',
    guide.trim()
  ].join('\n')
}
