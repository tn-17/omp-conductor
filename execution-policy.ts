import { discoverCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";

/** The native executor cannot yet disable command-module discovery separately
 * from disabling the explicit guarded tools and policy extension. Fail closed
 * before session construction instead of importing repository/user code. */
export async function assertNoExecutableCommands(cwd: string): Promise<void> {
  const discovered = await discoverCustomCommands({ cwd });
  if (discovered.paths.length) {
    throw new Error(
      `Conduct refuses auto-discovered executable command modules: ${discovered.paths.map((entry) => entry.path).join(", ")}. ` +
        "The current OMP executor cannot disable this startup execution while retaining guarded tools. Use a workspace and user configuration without these modules; no commands were imported or executed by Conduct.",
    );
  }
}
