// The Multimine plugin SDK. A plugin page includes it with
//   <script src="mmplugin://sdk/multimine.js"></script>
// and gets window.multimine: promise-returning calls that Multimine checks against the
// permissions the user granted the plugin. Nothing else of the app is reachable from the page.
;(function () {
  var next = 0
  // the host gave this page a token in its address; every call carries it so the host can route it
  var host = new URLSearchParams(location.search).get('mmhost') || ''
  var waiting = new Map()
  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || d.mm !== 1 || !('reply' in d)) return
    var w = waiting.get(d.reply)
    if (!w) return
    waiting.delete(d.reply)
    if (d.error) w.reject(new Error(d.error))
    else w.resolve(d.result)
  })
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1)
    return new Promise(function (resolve, reject) {
      var id = ++next
      waiting.set(id, { resolve: resolve, reject: reject })
      window.parent.postMessage({ mm: 1, host: host, id: id, method: method, args: args }, '*')
    })
  }
  window.multimine = {
    apiVersion: 2,
    call: call,
    info: function () { return call('info') },
    storage: {
      get: function (key) { return call('storage.get', key) },
      set: function (key, value) { return call('storage.set', key, value) }
    },
    ui: {
      toast: function (text) { return call('ui.toast', text) },
      setTitle: function (title) { return call('ui.setTitle', title) },
      close: function () { return call('ui.close') }
    },
    chats: { list: function () { return call('chats.list') } },
    // api 1: every chat, listed as an agent with role "custom"
    team: { list: function () { return call('team.list') } },
    // to: a chat id, 'active' (the chat on screen) or 'new'; resolves to { chatId }.
    // options, for a new chat: mcp - MCP server ids (set up in Settings) it starts with; planMode - start in plan mode
    send: function (to, text, options) { return call('send', to, text, options) },
    task: function (to, title, text, options) { return call('task', to, title, text, options) },
    ide: { open: function (path, line) { return call('ide.open', path, line) } },
    files: {
      list: function (dir) { return call('files.list', dir || '') },
      read: function (path, encoding) { return call('files.read', path, encoding || 'utf8') },
      write: function (path, data, encoding) { return call('files.write', path, data, encoding || 'utf8') },
      remove: function (path) { return call('files.remove', path) }
    },
    media: {
      show: function (source, title) { return call('media.show', source, title) },
      list: function () { return call('media.list') }
    }
  }
})()
