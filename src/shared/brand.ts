/**
 * The product's name and what it is. One place, so that a screen, a dialog and an AppPort manifest cannot disagree.
 *
 * Foundry is the developer workbench where agents build software: give an agent work in a project, watch what it does,
 * approve what it asks to do, and inspect what it changed. It is not a chat application.
 *
 * What Foundry is *not* the name of: the AppPort protocol, `@appport/github`, FeltDB, PAX, Compute or AuthBoundry —
 * those are separate things Foundry works with (see docs/foundry.md). The old name survives only as compatibility
 * identifiers (docs/foundry-identifiers.md).
 */
export const PRODUCT_NAME = 'Foundry'
export const PRODUCT_NAME_DEV = 'Foundry Dev'
export const PRODUCT_TAGLINE = 'The developer workbench where agents build software.'

/** The name a person sees for this build. */
export const displayName = (development: boolean): string => development ? PRODUCT_NAME_DEV : PRODUCT_NAME
