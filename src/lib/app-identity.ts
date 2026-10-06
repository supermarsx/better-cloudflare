/**
 * The application's name, in one place.
 *
 * It had drifted into four spellings: `productName` in `tauri.conf.json` and
 * the web metadata said "Better Cloudflare", the OS window title said "Better
 * Cloudflare DNS Manager", and the in-app title bar said "Better Cloudflare
 * Console" — a fifth phrase again once translated. The window manager's title
 * and the bar beneath it are inches apart on screen, so disagreeing there is
 * visible rather than theoretical.
 *
 * Deliberately not translated. A product name is a proper noun; the twelve
 * catalogue entries for "Better Cloudflare Console" had each invented a
 * descriptive phrase ("Console de Better Cloudflare", "the improved Cloudflare
 * console") instead, which is a different thing from the app's name.
 *
 * `tauri.conf.json` is the authority, because it names the bundle, the
 * executable and the installer, and JSON cannot import this constant.
 * `test/appIdentity.test.ts` reads that file and fails if the two disagree, so
 * the duplication cannot drift back apart.
 */
export const APP_TITLE = "Better Cloudflare";
