import type { ExpoConfig, Platform } from '@expo/config';
import spawnAsync from '@expo/spawn-async';
import fs from 'fs-extra';
import type { composeSourceMaps } from 'metro-source-map';
import os from 'os';
import path from 'path';
import process from 'process';
import resolveFrom from 'resolve-from';

export function isEnableHermesManaged(expoConfig: ExpoConfig, platform: Platform): boolean {
  switch (platform) {
    case 'android':
      return expoConfig.android?.jsEngine === 'hermes';
    default:
      return false;
  }
}

interface HermesBundleOutput {
  hbc: Uint8Array;
  sourcemap: string;
}
export async function buildHermesBundleAsync(
  projectRoot: string,
  code: string,
  map: string,
  optimize: boolean = false
): Promise<HermesBundleOutput> {
  const tempDir = path.join(os.tmpdir(), `expo-bundler-${process.pid}`);
  await fs.ensureDir(tempDir);
  try {
    const tempBundleFile = path.join(tempDir, 'index.bundle');
    const tempSourcemapFile = path.join(tempDir, 'index.bundle.map');
    await fs.writeFile(tempBundleFile, code);
    await fs.writeFile(tempSourcemapFile, map);

    const tempHbcFile = path.join(tempDir, 'index.hbc');
    const hermesCommand = getHermesCommand(projectRoot);
    const args = ['-emit-binary', '-out', tempHbcFile, tempBundleFile, '-output-source-map'];
    if (optimize) {
      args.push('-O');
    }
    await spawnAsync(hermesCommand, args);

    const [hbc, sourcemap] = await Promise.all([
      fs.readFile(tempHbcFile),
      createHermesSourcemapAsync(projectRoot, map, `${tempHbcFile}.map`),
    ]);
    return {
      hbc,
      sourcemap,
    };
  } finally {
    await fs.remove(tempDir);
  }
}

export async function createHermesSourcemapAsync(
  projectRoot: string,
  sourcemap: string,
  hermesMapFile: string
): Promise<string> {
  const composeSourceMaps = importMetroSourceMapFromProject(projectRoot);
  const bundlerSourcemap = JSON.parse(sourcemap);
  const hermesSourcemap = await fs.readJSON(hermesMapFile);
  return JSON.stringify(composeSourceMaps([bundlerSourcemap, hermesSourcemap]));
}

function getHermesCommand(projectRoot: string): string {
  const platformExecutable = getHermesCommandPlatform();
  const resolvedPath = resolveFrom.silent(projectRoot, `hermes-engine/${platformExecutable}`);
  if (!resolvedPath) {
    throw new Error(
      `Missing module "hermes-engine/${platformExecutable}" in the project.` +
        'This usually means hermes-engine is not installed. ' +
        'Please verify that dependencies in package.json include "react-native" ' +
        'and run `yarn` or `npm install`.'
    );
  }
  return resolvedPath;
}

function getHermesCommandPlatform(): string {
  switch (os.platform()) {
    case 'darwin':
      return 'osx-bin/hermesc';
    case 'linux':
      return 'linux64-bin/hermesc';
    case 'win32':
      return 'win64-bin/hermesc.exe';
    default:
      throw new Error(`Unsupported host platform for Hermes compiler: ${os.platform()}`);
  }
}

export function parseGradleProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const sepIndex = line.indexOf('=');
    const key = line.substr(0, sepIndex);
    const value = line.substr(sepIndex + 1);
    result[key] = value;
  }
  return result;
}

export async function maybeInconsistentEngineAsync(
  projectRoot: string,
  platform: string,
  isHermesManaged: boolean
): Promise<boolean> {
  switch (platform) {
    case 'android':
      return maybeInconsistentEngineAndroidAsync(projectRoot, isHermesManaged);
    default:
      return false;
  }
}

async function maybeInconsistentEngineAndroidAsync(
  projectRoot: string,
  isHermesManaged: boolean
): Promise<boolean> {
  // Trying best to check android native project if by chance to be consistent between app config

  // Check android/app/build.gradle for "enableHermes: true"
  const appBuildGradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (fs.existsSync(appBuildGradlePath)) {
    const content = await fs.readFile(appBuildGradlePath, 'utf8');
    const isPropsReference =
      content.search(
        /^\s*enableHermes:\s*\(findProperty\('expo.jsEngine'\) \?: "jsc"\) == "hermes",?\s+/m
      ) >= 0;
    const isHermesBare = content.search(/^\s*enableHermes:\s*true,?\s+/m) >= 0;
    if (!isPropsReference && isHermesManaged !== isHermesBare) {
      return true;
    }
  }

  // Check gradle.properties from prebuild template
  const gradlePropertiesPath = path.join(projectRoot, 'android', 'gradle.properties');
  if (fs.existsSync(gradlePropertiesPath)) {
    const props = parseGradleProperties(await fs.readFile(gradlePropertiesPath, 'utf8'));
    const isHermesBare = props['expo.jsEngine'] === 'hermes';
    if (isHermesManaged !== isHermesBare) {
      return true;
    }
  }

  return false;
}

function importMetroSourceMapFromProject(projectRoot: string): typeof composeSourceMaps {
  const resolvedPath = resolveFrom.silent(projectRoot, 'metro-source-map/src/composeSourceMaps');
  if (!resolvedPath) {
    throw new Error(
      'Missing module "metro-source-map/src/composeSourceMaps" in the project. ' +
        'This usually means React Native is not installed. ' +
        'Please verify that dependencies in package.json include "react-native" ' +
        'and run `yarn` or `npm install`.'
    );
  }
  return require(resolvedPath);
}

// https://github.com/facebook/hermes/blob/release-v0.5/include/hermes/BCGen/HBC/BytecodeFileFormat.h#L24-L25
const HERMES_MAGIC_HEADER = 'c61fbc03c103191f';

export async function isHermesBytecodeBundleAsync(file: string): Promise<boolean> {
  const header = await readHermesHeaderAsync(file);
  return header.slice(0, 8).toString('hex') === HERMES_MAGIC_HEADER;
}

export async function getHermesBytecodeBundleVersionAsync(file: string): Promise<number> {
  const header = await readHermesHeaderAsync(file);
  if (header.slice(0, 8).toString('hex') !== HERMES_MAGIC_HEADER) {
    throw new Error('Invalid hermes bundle file');
  }
  return header.readUInt32LE(8);
}

async function readHermesHeaderAsync(file: string): Promise<Buffer> {
  const fd = await fs.open(file, 'r');
  const buffer = Buffer.alloc(12);
  await fs.read(fd, buffer, 0, 12, null);
  await fs.close(fd);
  return buffer;
}
