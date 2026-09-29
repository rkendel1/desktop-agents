/**
 * Compatibility identity — not the product's display name (that is `displayName` in shared/brand.ts: "Foundry").
 *
 * Chromium derives the macOS Keychain service that protects stored credentials ("<name> Safe Storage") from the
 * application name, and the user-data directory has always been named after it. Renaming either would strand every
 * credential and the whole FeltDB flow of an existing installation, so both keep the names they have always had until
 * a deliberate migration moves them. Everything a person reads is Foundry.
 */
export function applicationName(development: boolean): 'Douchat Dev' | 'Douchat' {
  return development ? 'Douchat Dev' : 'Douchat'
}

export function userDataDirectoryName(development: boolean): 'douchat-dev' | 'douchat' {
  return development ? 'douchat-dev' : 'douchat'
}
