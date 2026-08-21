import { readFileSync } from 'node:fs'

/**
 * The mark of Orbit.
 *
 * The package serves no file of its own, thus the mark is written in the page
 * and given to the tab as an address of data. One file answers for the two.
 */
const source = readFileSync(new URL('../templates/orbit.svg', import.meta.url), 'utf-8')

/** The mark, to write in the page. */
export const logo = source

/** The mark, as the address that the tab of the browser reads. */
export const favicon = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`
