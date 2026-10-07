import type { JetBrainsIconName } from './assetUrls';
import { isBazelSourceFile } from '../files/bazel';
import { isGoTestFile } from '../project/fileClassification';
import { resolveLanguageForPath } from '../languages/resolver';

const extensions: Readonly<Record<string, JetBrainsIconName>> = {
  // Languages without a verified redistributable type-specific asset use IntelliJ's text icon.
  abap: 'file', aes: 'file', apex: 'file', cls: 'file', azcli: 'file-shell',
  bicep: 'file-config', bicepparam: 'file-config', c: 'file', h: 'file', cc: 'file', cpp: 'file',
  cxx: 'file', 'c++': 'file', hh: 'file', hpp: 'file', hxx: 'file', 'h++': 'file', inl: 'file', ipp: 'file', tpp: 'file',
  cu: 'file', cuh: 'file', cbl: 'file', cob: 'file', coffee: 'file', litcoffee: 'file',
  cs: 'file', csx: 'file', cake: 'file', clj: 'file', cljs: 'file', cljc: 'file', edn: 'file',
  ex: 'file', exs: 'file', erl: 'file', hrl: 'file', elm: 'file', ecl: 'file', flow: 'file',
  fs: 'file-fsharp', fsi: 'file-fsharp-signature', fsx: 'file-fsharp-script', fsscript: 'file-fsharp-script',
  f: 'file', for: 'file', f90: 'file', f95: 'file', f03: 'file', f08: 'file',
  gql: 'file-graphql', graphql: 'file-graphql', graphqls: 'file-graphql',
  hbs: 'file-handlebars', handlebars: 'file-handlebars', mustache: 'file-handlebars',
  hs: 'file', lhs: 'file', hx: 'file', hxml: 'file-config', jl: 'file',
  lua: 'file', luau: 'file', m: 'file', mm: 'file', ml: 'file', mli: 'file', mll: 'file', mly: 'file',
  mligo: 'file', ligo: 'file', pas: 'file', p: 'file', pp: 'file',
  pq: 'file', pqm: 'file', dats: 'file', sats: 'file', hats: 'file',
  ps1: 'file-shell', psm1: 'file-shell', psd1: 'file-shell', bat: 'file-windows', cmd: 'file-windows',
  pug: 'file-pug', jade: 'file-pug', r: 'file-r', rhistory: 'file-r', rprofile: 'file-r', rt: 'file-r',
  rmd: 'file-r-markdown', qmd: 'file-r-markdown', rnw: 'file-r-markdown',
  redis: 'file-database', rq: 'file-sql', sparql: 'file-sql', cypher: 'file-sql', cyp: 'file-sql',
  dax: 'file-sql', msdax: 'file-sql', scm: 'file', ss: 'file', sch: 'file', rkt: 'file', lisp: 'file', lsp: 'file', el: 'file',
  s: 'file', asm: 'file', inc: 'file', sb: 'file', sol: 'file', swift: 'file', tcl: 'file', tk: 'file',
  st: 'file', iecst: 'file', iecplc: 'file', lc3lib: 'file', tcpou: 'file', tcdut: 'file', tcgvl: 'file', tcio: 'file',
  sv: 'file', svh: 'file', v: 'file', vh: 'file', vhd: 'file', vhdl: 'file',
  tsp: 'file', qs: 'file', vb: 'file', vbs: 'file', bas: 'file',
  wgsl: 'file', glsl: 'file', vert: 'file', frag: 'file', geom: 'file', comp: 'file', hlsl: 'file', shader: 'file',
  lex: 'file', pla: 'file', m3: 'file', i3: 'file', mg: 'file', ig: 'file', csp: 'file-config',
  nix: 'file-config', nsi: 'file-config', nsh: 'file-config', nim: 'file', nims: 'file', zig: 'file', d: 'file',
  cmake: 'file-config', mk: 'file-config', mak: 'file-config', make: 'file-config', ninja: 'file-config',
  astro: 'file-astro', prisma: 'file-prisma', feature: 'file-gherkin',
  ftl: 'file-html', ftlh: 'file-html', ftlx: 'file-xml', liquid: 'file-html', twig: 'file-html',
  erb: 'file-html', ejs: 'file-html', haml: 'file-html', slim: 'file-html', jinja: 'file-html', jinja2: 'file-html', j2: 'file-html',
  cshtml: 'file-html', vbhtml: 'file-html', razor: 'file-html', asp: 'file-html', aspx: 'file-html',
  tex: 'file', ltx: 'file', bib: 'file', sty: 'file', rst: 'file', adoc: 'file', asciidoc: 'file', org: 'file',
  ts: 'file-ts', mts: 'file-ts', cts: 'file-ts', tsx: 'file-tsx',
  js: 'file-js', mjs: 'file-js', cjs: 'file-js', jsx: 'file-jsx',
  ipynb: 'file-json', har: 'file-json', geojson: 'file-json', webmanifest: 'file-json',
  json: 'file-json', jsonc: 'file-json', json5: 'file-json',
  yaml: 'file-yaml', yml: 'file-yaml', md: 'file-markdown', mdx: 'file-markdown', markdown: 'file-markdown',
  mdown: 'file-markdown', mkdn: 'file-markdown', mkd: 'file-markdown', mdwn: 'file-markdown', mdtxt: 'file-markdown', mdtext: 'file-markdown',
  css: 'file-css', scss: 'file-css', sass: 'file-css', less: 'file-less',
  shtml: 'file-html', jshtm: 'file-html', mdoc: 'file-html',
  html: 'file-html', htm: 'file-html', sh: 'file-shell', bash: 'file-shell', zsh: 'file-shell', fish: 'file-shell',
  dtd: 'file-xml', ascx: 'file-xml', csproj: 'file-xml', fsproj: 'file-xml', vbproj: 'file-xml', vcxproj: 'file-xml',
  props: 'file-xml', targets: 'file-xml', wxi: 'file-xml', wxl: 'file-xml', wxs: 'file-xml', xaml: 'file-xml', opf: 'file-xml', plist: 'file-xml', resx: 'file-xml',
  xml: 'file-xml', xsd: 'file-xsd', xsl: 'file-xml', xslt: 'file-xml', wsdl: 'file-wsdl', xhtml: 'file-xhtml',
  jav: 'file-java', es6: 'file-js', ctp: 'file-php', rbx: 'file-ruby', rjs: 'file-ruby', rpy: 'file-python', cpy: 'file-python', gyp: 'file-python', gypi: 'file-python', sbt: 'file-scala',
  java: 'file-java', class: 'file-java-class', kt: 'file-kotlin', kts: 'file-kotlin', aj: 'file-aspectj',
  groovy: 'file-groovy', gvy: 'file-groovy', gy: 'file-groovy', gsh: 'file-groovy', gradle: 'file-gradle',
  py: 'file-python', pyi: 'file-python', pyw: 'file-python', pyx: 'file-python', pxd: 'file-python', pxi: 'file-python',
  go: 'file-go', tf: 'file-terraform', tfvars: 'file-terraform', hcl: 'file-hcl', nomad: 'file-hcl', proto: 'file-proto',
  rs: 'file-rust', dart: 'file-dart', vue: 'file-vue', svelte: 'file-svelte', scala: 'file-scala', sc: 'file-scala',
  rb: 'file-ruby', rake: 'file-ruby', gemspec: 'file-ruby', php: 'file-php', phtml: 'file-php', php3: 'file-php', php4: 'file-php', php5: 'file-php', phps: 'file-php',
  pl: 'file-perl', pm: 'file-perl', pod: 'file-perl', as: 'file-actionscript', jsp: 'file-jsp', jspx: 'file-jspx',
  sql: 'file-sql', toml: 'file-toml', idl: 'file-idl', thrift: 'file-idl', http: 'file-http', rest: 'file-http',
  patch: 'file-patch', diff: 'file-patch', map: 'file-source-map', form: 'file-form', regexp: 'file-regexp',
  gitconfig: 'file-config', config: 'file-xml', ini: 'file-config', cfg: 'file-config', conf: 'file-config', properties: 'file-properties', lock: 'file-config',
  ttf: 'file-font', otf: 'file-font', woff: 'file-font', woff2: 'file-font', eot: 'file-font',
  tif: 'file-image', tiff: 'file-image', heic: 'file-image', heif: 'file-image', jxl: 'file-image', raw: 'file-image', psd: 'file-image', ai: 'file-image', eps: 'file-image', svgz: 'file-image',
  png: 'file-image', jpg: 'file-image', jpeg: 'file-image', gif: 'file-image', webp: 'file-image', svg: 'file-image', ico: 'file-image', avif: 'file-image', bmp: 'file-image',
  mp3: 'play', wav: 'play', ogg: 'play', oga: 'play', flac: 'play', m4a: 'play', aac: 'play', mp4: 'play', m4v: 'play', webm: 'play', ogv: 'play',
  avi: 'play', mov: 'play', mkv: 'play', mpeg: 'play', mpg: 'play', wmv: 'play', aiff: 'play', aif: 'play', opus: 'play', mid: 'play', midi: 'play',
  rar: 'file-archive', zst: 'file-archive', zstd: 'file-archive', br: 'file-archive', lz: 'file-archive', lzma: 'file-archive', cab: 'file-archive', war: 'file-archive', ear: 'file-archive', apk: 'file-archive', deb: 'file-archive', rpm: 'file-archive', nupkg: 'file-archive', whl: 'file-archive', gem: 'file-archive',
  zip: 'file-archive', gz: 'file-archive', tar: 'file-archive', tgz: 'file-archive', bz2: 'file-archive', xz: 'file-archive', '7z': 'file-archive', jar: 'file-archive',
  bin: 'file-binary', wasm: 'file-wasm', wat: 'file-wasm', wast: 'file-wasm', exe: 'file-binary', dll: 'file-binary', so: 'file-binary', dylib: 'file-binary', pyc: 'file-binary', pyo: 'file-binary', pyd: 'file-binary',
  o: 'file-binary', obj: 'file-binary', a: 'file-binary', lib: 'file-binary', rlib: 'file-binary', pdb: 'file-binary', dat: 'file-binary', iso: 'file-binary', dmg: 'file-binary',
  pdf: 'file', doc: 'file', docx: 'file', odt: 'file', rtf: 'file', ppt: 'file', pptx: 'file', odp: 'file', xls: 'file-csv', xlsx: 'file-csv', ods: 'file-csv',
  db: 'file-database', sqlite: 'file-database', sqlite3: 'file-database', db3: 'file-database', mdb: 'file-database', parquet: 'file-database', arrow: 'file-database', avro: 'file-database', orc: 'file-database', feather: 'file-database',
  pem: 'file-config', crt: 'file-config', cer: 'file-config', key: 'file-config', pub: 'file-config',
  txt: 'file', log: 'file', csv: 'file-csv', tsv: 'file-csv',
};

const filenames: Readonly<Record<string, JetBrainsIconName>> = {
  'makefile': 'file-config', 'gnumakefile': 'file-config', 'bsdmakefile': 'file-config', 'justfile': 'file-config',
  'cmakelists.txt': 'file-config', 'cmakecache.txt': 'file-config',
  '.rprofile': 'file-r', '.rhistory': 'file-r', '.renviron': 'file-config',
  '.bashrc': 'file-shell', '.bash_profile': 'file-shell', '.bash_login': 'file-shell', '.bash_logout': 'file-shell',
  '.zshrc': 'file-shell', '.zprofile': 'file-shell', '.zshenv': 'file-shell', '.profile': 'file-shell', 'bashrc': 'file-shell', 'zshrc': 'file-shell',
  'cargo.lock': 'file-toml', 'pipfile': 'file-toml', 'pipfile.lock': 'file-json', 'composer.lock': 'file-json', 'flake.lock': 'file-json',
  '.babelrc': 'file-json', '.eslintrc': 'file-json', '.jshintrc': 'file-json', '.stylelintrc': 'file-json', '.prettierrc': 'file-config',
  '.gitconfig': 'file-config', '.gitkeep': 'file-gitignore', '.dockerignore': 'file-docker',
  '.gitignore': 'file-gitignore', '.editorconfig': 'file-editorconfig',
  '.bazelrc': 'file-bazel', '.bazelversion': 'file-bazel',
  'go.mod': 'file-go-mod', 'go.sum': 'file-go-sum', 'go.work': 'file-go-work', 'go.work.sum': 'file-go-sum',
  'terragrunt.hcl': 'file-terragrunt', 'terragrunt.hcl.json': 'file-terragrunt',
  'gemfile': 'file-ruby', 'rakefile': 'file-ruby', 'guardfile': 'file-ruby',
  'jenkinsfile': 'file-groovy', 'manifest.mf': 'file-manifest',
};

// Specific compound suffixes must win over their final JSON/Kotlin extension.
const suffixes: readonly (readonly [string, JetBrainsIconName])[] = [
  ['.tf.json', 'file-terraform'], ['.tfvars.json', 'file-terraform'], ['.hcl.json', 'file-hcl'],
  ['.blade.php', 'file-php'], ['.html.erb', 'file-ruby'], ['.js.erb', 'file-ruby'],
  ['.schema.json', 'file-json-schema'], ['.gradle.kts', 'file-gradle'],
];

function lookup(table: Readonly<Record<string, JetBrainsIconName>>, key: string): JetBrainsIconName | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Paths are repository-relative POSIX paths, not URLs. File contents are never read. */
export function iconNameForPath(path: string): JetBrainsIconName {
  if (isGoTestFile(path)) return 'file-go-test';
  if (isBazelSourceFile(path)) return 'file-bazel';
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const filename = lookup(filenames, name);
  if (filename) return filename;
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile') || name === 'containerfile' || name.startsWith('containerfile.') || name.endsWith('.containerfile')) return 'file-docker';
  if (/^(?:gnu|bsd)?makefile(?:\.|$)/.test(name)) return 'file-config';
  if (name === '.env' || name.startsWith('.env.') || name === '.gitattributes' || name === '.npmrc' || name === '.gitmodules') return 'file-config';
  if (/^(license|licence|notice|readme)(\.txt)?$/.test(name)) return 'file';
  for (const [suffix, icon] of suffixes) if (name.endsWith(suffix)) return icon;
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? lookup(extensions, name.slice(dot + 1)) : undefined;
  if (extension) return extension;
  // The filename-only resolver is pure metadata; tree rendering never loads tokenizers.
  return resolveLanguageForPath(path) !== 'plaintext' ? 'file' : 'file-unknown';
}
