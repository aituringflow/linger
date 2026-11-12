import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loginWorkBuddy, logoutWorkBuddy } from "./provider-auth.js";

const usage = `Usage: agent-kit <login|logout> [--no-open]

  login      Sign in to WorkBuddy with browser authorization
  logout     Sign out of WorkBuddy
  --no-open  Print the authorization URL without opening a browser
`;

function openBrowser(url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {}); // The printed link remains available when no browser is installed.
  child.unref();
}

export async function runAuthCli(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))) {
    console.log(usage);
    return 0;
  }
  const [command, ...options] = args;
  if ((command !== "login" && command !== "logout") || options.some((arg) => arg !== "--no-open") || (command === "logout" && options.length > 0)) {
    console.error(usage);
    return 1;
  }
  if (command === "logout") {
    const result = await logoutWorkBuddy();
    if (!result.ok) { console.error(`Logout failed: ${result.error}`); return 1; }
    console.log("Signed out of WorkBuddy.");
    return 0;
  }
  const result = await loginWorkBuddy({
    onAuthUrl: (url) => {
      console.log(`Open this URL to authorize WorkBuddy:\n${url}`);
      if (!options.includes("--no-open")) openBrowser(url);
    },
  });
  if (!result.ok) { console.error(`Login failed: ${result.error}`); return 1; }
  console.log("Signed in to WorkBuddy.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
