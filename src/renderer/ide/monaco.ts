import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

// Monaco is bundled with the app and its workers built by Vite: nothing is fetched from a CDN, which
// the window's content policy forbids anyway, and the editor works offline.
;(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

monaco.editor.defineTheme('multimine', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7c84b8', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: 'a5e3b5' },
    { token: 'number', foreground: 'f9b27c' },
    { token: 'type', foreground: '7dd3fc' }
  ],
  colors: {
    'editor.background': '#080a1c',
    'editor.lineHighlightBackground': '#141836',
    'editorLineNumber.foreground': '#3b4170',
    'editorLineNumber.activeForeground': '#a5b4fc',
    'editor.selectionBackground': '#3b2f7a',
    'editorCursor.foreground': '#c084fc',
    'editorWidget.background': '#0e1130',
    'editorIndentGuide.background1': '#151a3a'
  }
})

loader.config({ monaco })

const BY_EXT: Record<string, string> = {
  java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'java', groovy: 'java', scala: 'scala',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', mcmeta: 'json', jsonc: 'json', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', lua: 'lua', php: 'php', swift: 'swift',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', properties: 'ini', cfg: 'ini', sh: 'shell', bash: 'shell',
  ps1: 'powershell', bat: 'bat', cmd: 'bat', sql: 'sql', vsh: 'cpp', fsh: 'cpp', glsl: 'cpp', dockerfile: 'dockerfile'
}

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  return BY_EXT[name.slice(name.lastIndexOf('.') + 1)] ?? 'plaintext'
}
