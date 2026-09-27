const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loader } = require('./load-typescript.cjs')

const load = loader()
const catalog = load('src/main/services/sunshineCatalog.ts')
const { DEFAULT_REPOSITORY } = load('src/main/types/repository.types.ts')
const copy = (v) => JSON.parse(JSON.stringify(v))
const index = () => ({
  patch: '16.19.1',
  champions: {
    Tristana: {
      skins: { 79: 'Risen Legend Tristana' },
      forms: { 79: { 80: 'Stage 2', 998: 'Stage 3', 999: 'Immortalized - Form 1' } }
    }
  }
})
const skin = (num, name, extra = {}) => ({
  id: `18_${num}`,
  num,
  name,
  chromas: false,
  rarity: 'kMythic',
  rarityGemPath: null,
  isLegacy: false,
  skinType: '',
  ...extra
})
const champion = () => ({
  id: 18,
  key: 'Tristana',
  name: 'Tristana',
  title: '',
  image: '',
  tags: [],
  skins: [
    skin(0, 'Tristana'),
    skin(79, 'Risen Legend Tristana'),
    skin(80, 'Immortalized Legend Tristana', {
      chromaList: [
        { id: 18999, name: 'Wrong old mirror form', colors: ['red'], chromaPath: 'old.png' }
      ]
    })
  ]
})

test('Tristana uses published IDs, parent, labels and label order instead of Riot tier order', () => {
  const source = champion()
  const projected = catalog.projectSunshineChampion(source, index())
  assert.deepEqual(copy(projected.skins.map((s) => s.num)), [0, 79])
  const forms = projected.skins[1].chromaList
  assert.deepEqual(copy(forms.map((c) => [c.id, c.name, c.kind])), [
    [18999, 'Immortalized - Form 1', 'form'],
    [18080, 'Stage 2', 'form'],
    [18998, 'Stage 3', 'form']
  ])
  assert.deepEqual(copy(forms[0].colors), [])
  assert.ok(!forms[0].chromaPath.includes('old.png'))
  assert.equal(source.skins.length, 3)
  for (const form of forms) {
    const pkg = catalog.resolveSunshinePackage(projected, `Risen Legend Tristana ${form.id}.zip`)
    assert.equal(pkg.path, `skins/Tristana/Risen Legend Tristana/${form.name}.fantome`)
    assert.match(
      catalog.sunshinePackageUrl(DEFAULT_REPOSITORY, pkg.path),
      /^https:\/\/github.com\/bettie9\/LeagueSkins\/blob\/main\//
    )
  }
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'Risen Legend Tristana').path,
    'skins/Tristana/Risen Legend Tristana.fantome'
  )
  assert.throws(
    () => catalog.resolveSunshinePackage(projected, 'Immortalized Legend Tristana'),
    /not uniquely published/
  )
})

test('publisher filenames preserve K_DA, PROJECT, apostrophes and trailing file dots', () => {
  const source = champion()
  const data = index()
  data.champions.Tristana = {
    skins: { 1: 'K/DA Test', 2: 'PROJECT: Test', 3: 'Kennen M.D.' },
    chromas: { 3: { 4: 'Ruby' } }
  }
  const projected = catalog.projectSunshineChampion(source, data)
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'KDA Test.zip').path,
    'skins/Tristana/K_DA Test.fantome'
  )
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'PROJECT Test').path,
    'skins/Tristana/PROJECT Test.fantome'
  )
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'Kennen M.D. 18004').path,
    'skins/Tristana/Kennen M.D/Ruby.fantome'
  )
  assert.equal(catalog.packageName('K.O.'), 'K.O.')
  assert.match(
    catalog.sunshinePackageUrl(DEFAULT_REPOSITORY, "skins/Tristana/It's #1.fantome"),
    /It's%20%231.fantome$/
  )
})

test('localized names, base chromas, low synthetic IDs and multiple parents remain distinct', () => {
  const source = champion()
  source.name = 'Localized champion'
  source.skins[1].name = 'Localized skin'
  const data = index()
  data.champions.Tristana.chromas = { 0: { 2: 'Ruby' } }
  data.champions.Tristana.skins[81] = 'Another skin'
  data.champions.Tristana.forms[81] = { 736: 'Stage 3' }
  const projected = catalog.projectSunshineChampion(source, data)
  assert.equal(projected.skins[1].name, 'Localized skin')
  assert.equal(projected.skins[1].nameEn, 'Risen Legend Tristana')
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'Localized champion 18002').path,
    'skins/Tristana/Tristana/Ruby.fantome'
  )
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'Another skin 18736').path,
    'skins/Tristana/Another skin/Stage 3.fantome'
  )
  assert.notEqual(
    catalog.resolveSunshinePackage(projected, 'Another skin 18736').filename,
    catalog.resolveSunshinePackage(projected, 'Risen Legend Tristana 18998').filename
  )
})

test('invalid catalogs and colliding IDs are rejected', () => {
  assert.equal(catalog.isSunshineCatalog(index()), true)
  for (const data of [null, {}, { patch: 'x', champions: {} }])
    assert.equal(catalog.isSunshineCatalog(data), false)
  const collision = index()
  collision.champions.Tristana.skins[80] = 'Collision'
  assert.equal(catalog.isSunshineCatalog(collision), false)
  const missingParent = index()
  missingParent.champions.Tristana.skins = {}
  assert.equal(catalog.isSunshineCatalog(missingParent), false)
})

test('Classic packages use published Jade aliases and paths, including chromas', () => {
  const classic = {
    schemaVersion: 1,
    champions: [
      {
        id: 60018,
        baseId: 18,
        key: 'Jade_Tristana',
        skins: [
          {
            id: '60018301',
            num: 301,
            name: 'Classic Tristana',
            path: 'Jade_Tristana/60018301.fantome'
          },
          {
            id: '60018302',
            num: 302,
            name: 'Classic Tristana (Ruby)',
            parentSkinId: '60018301',
            path: 'Jade_Tristana/60018302.fantome'
          }
        ]
      }
    ]
  }
  assert.ok(catalog.isClassicCatalog(classic))
  const projected = catalog.projectSunshineChampion(champion(), index(), classic)
  assert.equal(
    catalog.resolveSunshinePackage(projected, '18_classic_301').path,
    'classic/Jade_Tristana/60018301.fantome'
  )
  assert.equal(
    catalog.resolveSunshinePackage(projected, 'Classic Tristana 60018302').path,
    'classic/Jade_Tristana/60018302.fantome'
  )
  classic.champions[0].skins[0].path = '../outside'
  assert.equal(catalog.isClassicCatalog(classic), false)
})

function serviceHarness(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bocchi-sunshine-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = { data: index(), calls: [], offline: false, settings }
  const modules = loader({
    electron: { app: { getPath: () => dir } },
    './settingsService': {
      settingsService: {
        get: (key) => (key === 'repositorySettings' ? state.settings : 'en_US'),
        set: (key, value) => {
          if (key === 'repositorySettings') state.settings = value
        }
      }
    },
    axios: {
      get: async (url) => {
        state.calls.push(url)
        if (state.offline) throw new Error('Offline')
        return {
          data: url.endsWith('/classic/index.json')
            ? { schemaVersion: 1, champions: [] }
            : state.data
        }
      }
    }
  })
  return { state, modules, dir }
}

test('catalog refresh deduplicates, retains last good data offline and recovers on refresh', async (t) => {
  const h = serviceHarness(t)
  const { SunshineCatalogService } = h.modules('src/main/services/sunshineCatalogService.ts')
  const service = new SunshineCatalogService()
  const [a, b] = await Promise.all([service.load(), service.load()])
  assert.equal(a, b)
  assert.equal(h.state.calls.length, 2)
  await service.load()
  assert.equal(h.state.calls.length, 2)
  h.state.offline = true
  assert.equal(await service.load(true), a)
  const restored = await new SunshineCatalogService().load()
  assert.deepEqual(copy(restored), copy(a))
  h.state.offline = false
  h.state.data = index()
  delete h.state.data.champions.Tristana.forms[79][998]
  const fresh = await service.load(true)
  assert.equal(fresh.catalog.champions.Tristana.forms[79][998], undefined)
  h.state.data = {}
  assert.equal(await service.load(true), fresh)
})

test('first-run outage fails without substituting another mirror catalog', async (t) => {
  const h = serviceHarness(t)
  h.state.offline = true
  const { SunshineCatalogService } = h.modules('src/main/services/sunshineCatalogService.ts')
  await assert.rejects(new SunshineCatalogService().load(), /Sunshine catalog unavailable/)
  assert.ok(h.state.calls.every((url) => url.includes('bettie9/LeagueSkins')))
})

function integrationHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bocchi-integration-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const projected = catalog.projectSunshineChampion(champion(), index())
  const custom = {
    ...DEFAULT_REPOSITORY,
    id: 'my-repo',
    owner: 'example',
    repo: 'custom',
    isDefault: false,
    isCustom: true
  }
  let settings = {
    repositories: [
      {
        ...DEFAULT_REPOSITORY,
        owner: 'Alban1911',
        structure: { type: 'id-based', skinsPath: 'skins', autoDetected: true }
      },
      custom
    ],
    activeRepositoryId: DEFAULT_REPOSITORY.id
  }
  const state = { requests: [], repaired: 0, fail: false }
  const axios = Object.assign(
    async (request) => {
      state.requests.push(request.url)
      if (state.fail) throw Object.assign(new Error('404'), { response: { status: 404 } })
      return {
        data: require('node:stream').Readable.from([Buffer.from('published fixture bytes')])
      }
    },
    {
      isAxiosError: () => true,
      get: async () => {
        throw new Error('Unexpected catalog fallback')
      }
    }
  )
  const mocks = {
    axios,
    electron: { app: { getPath: () => dir } },
    './settingsService': {
      settingsService: {
        get: (key) => (key === 'repositorySettings' ? settings : 'en_US'),
        set: (key, value) => {
          if (key === 'repositorySettings') settings = value
        }
      }
    },
    './championDataService': {
      championDataService: {
        getChampionByIdSync: () => projected,
        getChampionByNameSync: () => projected,
        loadChampionData: async () => ({ champions: [projected] })
      }
    },
    './sunshineCatalogService': {
      sunshineCatalogService: { current: () => ({ catalog: index() }) }
    },
    './repositoryDetector': { repositoryDetector: {} },
    './githubApiService': {
      githubApiService: {
        parseGitHubPathFromUrl: () => '',
        getLatestCommitForSkin: async () => null
      }
    },
    './skinMetadataService': { skinMetadataService: {} },
    './modRepairService': {
      repairModFile: async () => {
        state.repaired++
        return { repaired: 0 }
      }
    },
    './skinMigrationService': { skinMigrationService: {} },
    './modToolsWrapper': { ModToolsWrapper: class {} }
  }
  const modules = loader(mocks)
  const repo = modules('src/main/services/repositoryService.ts').repositoryService
  mocks['./repositoryService'] = { repositoryService: repo }
  const { SkinDownloader } = modules('src/main/services/skinDownloader.ts')
  return { repo, downloader: new SkinDownloader(), dir, state, projected }
}

test('existing default migrates to Sunshine and custom repository settings survive', (t) => {
  const { repo } = integrationHarness(t)
  assert.equal(repo.getActiveRepository().owner, 'bettie9')
  assert.equal(repo.getActiveRepository().structure.type, 'name-based')
  assert.equal(repo.getActiveRepository().structure.fileExtension, 'fantome')
  assert.equal(repo.getRepositoryById('my-repo').owner, 'example')
  assert.equal(
    repo.constructGitHubUrl('Tristana', 'Risen Legend Tristana 18080', true, undefined, 18),
    'https://github.com/bettie9/LeagueSkins/blob/main/skins/Tristana/Risen%20Legend%20Tristana/Stage%202.fantome'
  )
})

test('single download resolves catalog URL to a unique local filename and preserves publisher bytes', async (t) => {
  const { repo, downloader, dir, state } = integrationHarness(t)
  const url = repo.constructGitHubUrl(
    'Tristana',
    'Risen Legend Tristana 18999',
    true,
    undefined,
    18
  )
  const result = await downloader.downloadSkin(url)
  assert.equal(result.championName, 'Tristana')
  assert.equal(result.skinName, 'Risen Legend Tristana 18999.fantome')
  assert.equal(
    result.localPath,
    path.join(dir, 'downloaded-skins-sunshine', 'Tristana', result.skinName)
  )
  assert.equal(fs.readFileSync(result.localPath, 'utf8'), 'published fixture bytes')
  assert.equal(state.repaired, 0)
  await downloader.downloadSkin(url)
  assert.equal(state.requests.length, 1)
  await assert.rejects(
    downloader.downloadSkin(url.replace('bettie9', 'Alban1911')),
    /different repository/
  )
  await assert.rejects(
    downloader.downloadSkin(url.replace('Immortalized%20-%20Form%201', 'Unpublished')),
    /not in the loaded/
  )
})

test('failed Sunshine download never searches for another Stage file or leaves a cached package', async (t) => {
  const { repo, downloader, dir, state } = integrationHarness(t)
  state.fail = true
  const url = repo.constructGitHubUrl(
    'Tristana',
    'Risen Legend Tristana 18998',
    true,
    undefined,
    18
  )
  await assert.rejects(downloader.downloadSkin(url), /Sunshine package download failed/)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'downloaded-skins-sunshine', 'Tristana')), [])
})

test('bulk import produces exactly the same form filenames as single downloads and honors form exclusion', async (t) => {
  const { downloader, dir, projected } = integrationHarness(t)
  const root = path.join(dir, 'archive')
  for (const entry of catalog.sunshinePackages(projected)) {
    const filename = path.join(root, entry.path)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, entry.path)
  }
  const options = { excludeChromas: false, excludeVariants: true, overwriteExisting: true }
  await downloader.processSkins(path.join(root, 'skins'), options, DEFAULT_REPOSITORY)
  const output = path.join(dir, 'downloaded-skins-sunshine', 'Tristana')
  assert.deepEqual(fs.readdirSync(output), ['Risen Legend Tristana.fantome'])
  await downloader.processSkins(
    path.join(root, 'skins'),
    { ...options, excludeVariants: false },
    DEFAULT_REPOSITORY
  )
  assert.deepEqual(
    fs.readdirSync(output).sort(),
    copy(catalog.sunshinePackages(projected).map((p) => `${p.filename}.fantome`)).sort()
  )
})

test('champion memory and lookup caches refresh when the catalog or repository changes', async () => {
  let active = true
  let snapshot = { catalog: index(), classic: null }
  const raw = { version: '16.19.1', champions: [champion()] }
  const modules = loader({
    electron: { app: {} },
    './championFetcher': { CHAMPION_DATA_REVISION: 3 },
    './remoteVariantsService': {
      remoteVariantsService: {
        getActiveVariants: () => {
          throw new Error('Must not fetch Alban variants')
        }
      }
    },
    './sunshineCatalogService': {
      sunshineCatalogService: {
        isActive: () => active,
        current: () => snapshot,
        load: async () => snapshot
      }
    }
  })
  const { ChampionDataService } = modules('src/main/services/championDataService.ts')
  const service = new ChampionDataService()
  service.cachedData.set('tr_TR', raw)
  const first = await service.loadChampionData('tr_TR')
  assert.equal(first.champions[0].skins[1].chromaList.length, 3)
  assert.equal(service.getChampionByIdSync(18).skins[1].chromaList.length, 3)
  snapshot = { catalog: index(), classic: null }
  delete snapshot.catalog.champions.Tristana.forms[79][998]
  await service.loadChampionData('tr_TR')
  assert.equal(service.getChampionByIdSync(18).skins[1].chromaList.length, 2)
  active = false
  assert.equal((await service.loadChampionData('tr_TR')).champions[0], raw.champions[0])
  assert.equal(service.getChampionByIdSync(18).skins[2].num, 80)
})

test('downloaded and cslol import caches are both isolated from previous repositories', () => {
  let repo = DEFAULT_REPOSITORY
  const modules = loader({
    electron: { app: { getPath: () => 'C:\\bocchi-test' } },
    './settingsService': {
      settingsService: { get: () => ({ repositories: [repo], activeRepositoryId: repo.id }) }
    },
    './nativeInjector': {}
  })
  const preImport = modules('src/main/services/preImportService.ts').preImportService
  const { ModToolsWrapper } = modules('src/main/services/modToolsWrapper.ts')
  const wrapper = new ModToolsWrapper()
  assert.equal(preImport.installedPath, wrapper.installedPath)
  assert.match(wrapper.installedPath, /cslol_installed-sunshine$/)
  assert.match(preImport.downloadedSkinsPath, /downloaded-skins-sunshine$/)
  repo = { ...repo, owner: 'Alban1911' }
  assert.match(wrapper.installedPath, /cslol_installed$/)
  assert.match(preImport.downloadedSkinsPath, /downloaded-skins$/)
})
