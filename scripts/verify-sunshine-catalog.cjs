// Optional online verification against one immutable mirror revision.
const assert = require('node:assert/strict')
const { loader } = require('../tests/load-typescript.cjs')
const load = loader()
const {
  isSunshineCatalog,
  isClassicCatalog,
  projectSunshineChampion,
  sunshinePackages,
  resolveSunshinePackage
} = load('src/main/services/sunshineCatalog.ts')

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  return response.json()
}

async function main() {
  const commit = await json('https://api.github.com/repos/bettie9/LeagueSkins/commits/main')
  const root = `https://raw.githubusercontent.com/bettie9/LeagueSkins/${commit.sha}`
  const [catalog, classic, summary, tree] = await Promise.all([
    json(`${root}/index.json`),
    json(`${root}/classic/index.json`),
    json(
      'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json'
    ),
    json(
      `https://api.github.com/repos/bettie9/LeagueSkins/git/trees/${commit.commit.tree.sha}?recursive=1`
    )
  ])
  assert.ok(isSunshineCatalog(catalog), 'Published regular catalog schema')
  assert.ok(isClassicCatalog(classic), 'Published Classic catalog schema')
  assert.equal(tree.truncated, false, 'GitHub tree must be complete')
  const files = new Set(
    tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  )
  let checked = 0
  const counts = { skin: 0, form: 0, chroma: 0 }
  let tristana
  for (const [key, published] of Object.entries(catalog.champions)) {
    const metadata = summary.find((c) => c.alias === key)
    assert.ok(metadata, `Champion ID for ${key}`)
    const champion = projectSunshineChampion(
      { id: metadata.id, key, name: metadata.name, title: '', image: '', tags: [], skins: [] },
      catalog,
      classic
    )
    const packages = sunshinePackages(champion)
    const expectedRegular =
      Object.keys(published.skins).length +
      ['forms', 'chromas'].reduce(
        (sum, kind) =>
          sum +
          Object.values(published[kind] || {}).reduce(
            (n, group) => n + Object.keys(group).length,
            0
          ),
        0
      )
    assert.equal(packages.filter((p) => p.path.startsWith('skins/')).length, expectedRegular)
    for (const entry of packages) {
      assert.ok(files.has(entry.path), `Missing published file: ${entry.path}`)
      assert.equal(
        resolveSunshinePackage(champion, entry.filename).path,
        entry.path,
        `Round trip: ${entry.filename}`
      )
      checked++
      counts[entry.kind]++
    }
    if (key === 'Tristana')
      tristana = packages.filter((p) => p.path.includes('Risen Legend Tristana'))
  }
  for (const entry of tristana) {
    const response = await fetch(
      `${root}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(30000) }
    )
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'Fantome ZIP header')
  }
  console.log(
    JSON.stringify(
      {
        revision: commit.sha,
        patch: catalog.patch,
        checked,
        counts,
        tristana: tristana.map((p) => p.path)
      },
      null,
      2
    )
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
