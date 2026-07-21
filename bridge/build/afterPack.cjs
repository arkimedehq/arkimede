// electron-builder `afterPack` hook — ad-hoc code-signs the macOS .app.
//
// Why: the bridge is built in CI without an Apple Developer ID, so it is neither
// Developer-ID-signed nor notarized. On Apple Silicon an app MUST carry at least
// an ad-hoc signature to launch at all — otherwise Gatekeeper hard-blocks it with
// "app is damaged, move it to the Trash". Ad-hoc signing here removes that hard
// block so the app is launchable.
//
// What it does NOT do: it is not a Developer ID signature and does not notarize.
// Users downloading from the internet still clear Gatekeeper ONCE (right-click →
// Open, or `xattr -dr com.apple.quarantine "/Applications/Arkimede Bridge.app"`).
// Full silent install would require a paid Apple account + notarization.
//
// Runs before the .dmg is assembled and only on macOS packs (x64 and arm64).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --deep signs nested frameworks/helpers inside-out; "-" is the ad-hoc identity;
  // --force replaces the signatures Electron ships with.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Best-effort verification (never fail the build on a verify hiccup).
  try {
    execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
  } catch (err) {
    console.warn(`[afterPack] codesign verify warning: ${err.message}`);
  }
};
