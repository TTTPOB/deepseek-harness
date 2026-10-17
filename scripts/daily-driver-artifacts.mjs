/** Stage local fork artifacts and their unpublished workspace peer closure for isolated consumers. */
import assert from 'node:assert/strict'
import { copyFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { officialVersion, plan, selections } from './daily-driver-plan.mjs'

/** Include forked peers even when another capability owns their tarballs. */
export function artifactClosure(packages) {
  const forks = new Map(Object.keys(selections).flatMap(selection => plan(selection).packages)
    .filter(pkg => pkg.version !== officialVersion).map(pkg => [pkg.name, pkg]))
  const closure = new Map(packages.map(pkg => [pkg.name, pkg]))
  for (const pkg of closure.values()) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      const fork = forks.get(name)
      if (fork && !closure.has(name)) closure.set(name, fork)
    }
  }
  return [...closure.values()]
}

/** Write overrides in the isolated workspace, never in the user's installation. */
export async function stageArtifactOverrides(runtime, packages, tarballs) {
  assert.equal(packages.length, tarballs.length)
  const explicit = new Map(packages.map((pkg, index) => [pkg.name, resolve(tarballs[index])]))
  const overrides = {}
  for (const pkg of artifactClosure(packages)) {
    const source = explicit.get(pkg.name) ?? plan(Object.keys(selections).find(selection =>
      selections[selection].packages.includes(pkg.directory))).artifact(pkg)
    await copyFile(source, join(runtime, basename(source)))
    overrides[pkg.name] = 'file:./' + basename(source)
  }
  if (process.env.DSH_PI_AI_TARBALL) {
    const source = resolve(process.env.DSH_PI_AI_TARBALL)
    await copyFile(source, join(runtime, basename(source)))
    overrides['@earendil-works/pi-ai'] = 'file:./' + basename(source)
  }
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), JSON.stringify({
    packages: ['.'], blockExoticSubdeps: false,
    allowBuilds: { esbuild: true, 'node-pty': true, koffi: true,
      '@google/genai': false, protobufjs: false, 'node-addon-require-builtin': false },
    overrides,
  }))
}
