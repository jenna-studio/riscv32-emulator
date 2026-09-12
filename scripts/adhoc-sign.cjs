// There is no Developer ID certificate for this project, so the release ships
// unsigned. On Apple Silicon a bundle with no signature at all is refused by the
// kernel, and the universal merge rewrites Mach-O files enough to invalidate the
// linker-signed ad-hoc signatures Electron ships with. Re-applying an ad-hoc
// signature over the finished bundle keeps the app launchable; users still have
// to clear the quarantine attribute, which the release notes explain.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== "darwin") return;

    // @electron/universal requires the two per-arch builds to have byte-identical
    // non-binary files, and signing rewrites _CodeSignature/CodeResources. Sign
    // only the merged bundle, never the "-temp" arch staging dirs.
    if (context.appOutDir.endsWith("-temp")) return;

    const appPath = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`
    );

    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
        stdio: "inherit",
    });
    console.log(`  • ad-hoc signed  ${appPath}`);
};
