import { posix as path } from 'node:path'
import ts from 'typescript'
import type { DependencyKind, ImportReference, RepositoryAnalysis } from '@archguard/contracts'

const root = '/snapshot'
const defaultOptions: ts.CompilerOptions = {
  allowJs: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
}

export function isSourcePath(file: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)
}

const declarationFile = /\.d\.([cm]?)ts$/i

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length && node.exportClause.elements.every((element) => element.isTypeOnly))
  }
  const clause = node.importClause
  return Boolean(clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)))
}

function readReferences(file: string, source: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) as
    ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  const references: ImportReference[] = []
  let computedImports = 0
  function add(node: ts.Node | undefined, kind: DependencyKind) {
    if (node && ts.isStringLiteralLike(node)) {
      references.push({
        from: file,
        specifier: node.text,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        kind,
      })
    }
  }
  // Use an explicit stack so deep syntax trees do not exhaust the call stack.
  const pending: ts.Node[] = [tree]
  while (pending.length) {
    const node = pending.pop()!
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, isTypeOnly(node) ? 'type' : ts.isImportDeclaration(node) ? 'import' : 're-export')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly ? 'type' : 'require')
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (dynamic || requireCall) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) add(argument, dynamic ? 'dynamic-import' : 'require')
        else computedImports++
      }
    }
    const children: ts.Node[] = []
    ts.forEachChild(node, (child) => { children.push(child) })
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index])
  }
  return { references, computedImports, syntaxWarning: Boolean(tree.parseDiagnostics?.length) }
}

function matchesPathAlias(specifier: string, paths: ts.MapLike<string[]> | undefined): boolean {
  return Object.keys(paths ?? {}).some((pattern) => {
    const star = pattern.indexOf('*')
    if (star < 0) return specifier === pattern
    return specifier.length >= pattern.length - 1 &&
      specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
  })
}

export function analyzeSources(snapshot: ReadonlyMap<string, string>): RepositoryAnalysis {
  const files = [...snapshot.keys()].filter(isSourcePath).sort()
  const contents = new Map<string, string>()
  const directories = new Set<string>([root])
  for (const [file, content] of snapshot) {
    const absolute = path.join(root, file)
    if (!absolute.startsWith(root + '/')) continue
    contents.set(absolute, content)
    for (let directory = path.dirname(absolute); !directories.has(directory); directory = path.dirname(directory)) {
      directories.add(directory)
    }
  }
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => root,
    fileExists: (file) => contents.has(path.normalize(file)),
    readFile: (file) => contents.get(path.normalize(file)),
    directoryExists: (directory) => directories.has(path.normalize(directory)),
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: () => {},
  } as ts.ParseConfigFileHost & ts.ModuleResolutionHost

  const configurationWarnings: string[] = []
  const optionsByConfig = new Map<string, ts.CompilerOptions>()
  function optionsFor(file: string): ts.CompilerOptions {
    for (let directory = path.dirname(file); directory.startsWith(root); directory = path.dirname(directory)) {
      const config = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(directory, name))
        .find((name) => contents.has(name))
      if (!config) continue
      const cached = optionsByConfig.get(config)
      if (cached) return cached
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host)
      if (!parsed || parsed.errors.some(({ code }) => code !== 18002 && code !== 18003)) {
        configurationWarnings.push(config.slice(root.length + 1))
      }
      const options: ts.CompilerOptions = { allowJs: true, ...parsed?.options }
      if (options.moduleResolution === undefined && options.module === undefined) {
        options.moduleResolution = defaultOptions.moduleResolution
      }
      optionsByConfig.set(config, options)
      return options
    }
    return defaultOptions
  }
  const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>()
  const dependencies: RepositoryAnalysis['dependencies'] = []
  const unresolved: ImportReference[] = []
  const syntaxWarningFiles: string[] = []
  let computedImportCount = 0
  let externalCount = 0
  for (const file of files) {
    const absolute = path.join(root, file)
    const options = optionsFor(absolute)
    let cache = caches.get(options)
    if (!cache) {
      cache = ts.createModuleResolutionCache(root, (name) => name, options)
      caches.set(options, cache)
    }
    const parsed = readReferences(file, snapshot.get(file)!)
    if (parsed.syntaxWarning) syntaxWarningFiles.push(file)
    computedImportCount += parsed.computedImports
    for (const reference of parsed.references) {
      const { specifier, kind } = reference
      const mode = kind === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext
      let resolved = ts.resolveModuleName(specifier, absolute, options, host, cache, undefined, mode)
        .resolvedModule?.resolvedFileName
      if (resolved && kind !== 'type' && !declarationFile.test(file)) {
        const declaration = declarationFile.exec(resolved)
        if (declaration) {
          const implementation = resolved.slice(0, declaration.index) + '.' + declaration[1] + 'js'
          resolved = contents.has(implementation) ? implementation : undefined
        }
      }
      if (resolved && resolved.startsWith(root + '/') && contents.has(resolved) && isSourcePath(resolved)) {
        dependencies.push({
          ...reference,
          kind: declarationFile.test(file) ? 'type' : reference.kind,
          to: resolved.slice(root.length + 1),
        })
      } else if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') ||
          matchesPathAlias(specifier, options.paths)) {
        unresolved.push(reference)
      } else {
        externalCount++
      }
      if (dependencies.length + unresolved.length + externalCount > 30_000) {
        throw new Error('导入引用数量超过 30,000 条，请选择较小的仓库。')
      }
    }
  }
  return { files, dependencies, unresolved, externalCount, configurationWarnings, syntaxWarningFiles, computedImportCount }
}
