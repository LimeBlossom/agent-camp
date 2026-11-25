/** Jailed agents cannot start Blender with `flatpak run`: it needs a sandbox of its own, which
 *  the agent jail refuses ("Unable to allocate instance id"). `hive-blender`, written into
 *  `<hive>/bin/runtime` by HiveManager.writeRuntimeShims, runs the flatpak's own binary instead. */

const FLATPAK_RUN_BLENDER = /(^|[;&|(])\s*([A-Za-z_][A-Za-z0-9_]*=\S*\s+)*flatpak\s+run\s+([^;|&\n]*\s)?org\.blender\.Blender\b/m;

const REASON = "Use hive-blender, not 'flatpak run org.blender.Blender'. Inside the agent jail flatpak run cannot start (it needs a sandbox of its own and dies with \"Unable to allocate instance id\"). hive-blender is on your PATH and runs the Blender flatpak's own binary with the same arguments, for example: hive-blender -b --version, or hive-blender -b file.blend -P script.py.";

/** The deny reason for a shell command line, or null when it may run. */
export function blenderGuardDeny(command: string): string | null {
  if (!command.includes('org.blender.Blender')) return null;
  return FLATPAK_RUN_BLENDER.test(command) ? REASON : null;
}
