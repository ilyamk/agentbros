/** Synthetic smoke typography only; real font QA retains the production loaders. */
export const fontFamily = 'Arial';
const ready = () => ({fontFamily,fonts:{},unicodeRanges:{},waitUntilDone:()=>Promise.resolve()});
export const loadFont=ready;
export const loadVariableFont=ready;
