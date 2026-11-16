/**
 * electron-builder afterPack hook — ad-hoc sign macOS builds.
 *
 * Without a Developer ID certificate electron-builder skips signing entirely,
 * leaving Electron's original signature invalidated by the edited Info.plist.
 * On Apple silicon such an app is reported as "damaged" and can't be opened at
 * all. An ad-hoc signature turns that into the ordinary "unidentified
 * developer" prompt, which users can get past (see README).
 *
 * This runs before electron-builder's own signing step. When a real identity
 * is configured (CSC_LINK / CSC_NAME / keychain), that step re-signs every
 * file with --force, so the ad-hoc signature is simply replaced.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appName = `${context.packager.appInfo.productFilename}.app`;
    const appPath = path.join(context.appOutDir, appName);
    console.log(`  • ad-hoc signing  ${appName}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
