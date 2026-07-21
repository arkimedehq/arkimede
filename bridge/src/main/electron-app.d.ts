// Extends Electron's App interface with the isQuitting flag.
// App lives in `declare namespace Electron { interface App }`,
// so the augmentation goes on Electron (global namespace), not on 'electron' (module).
declare namespace Electron {
  interface App {
    isQuitting: boolean
  }
}
