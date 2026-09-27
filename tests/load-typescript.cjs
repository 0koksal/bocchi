const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Compile the production TypeScript in memory; no Electron process or game files needed.
function loader(mocks = {}) {
  const modules = new Map()
  function load(filename) {
    filename = path.resolve(filename)
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }
    modules.set(filename, module.exports)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText
    const requireModule = (id) => {
      if (id in mocks) return mocks[id]
      if (!id.startsWith('.')) return require(id)
      return load(path.resolve(path.dirname(filename), `${id}.ts`))
    }
    vm.runInNewContext(
      code,
      {
        module,
        exports: module.exports,
        require: requireModule,
        console: { ...console, warn() {}, log() {}, info() {}, debug() {} },
        Date,
        URL,
        Buffer,
        setTimeout,
        clearTimeout
      },
      { filename }
    )
    return module.exports
  }
  return load
}

module.exports = { loader }
