// The renderer is a plain script, so the bridge is declared globally.
interface Window {
  sb: import('../types').SwitchboardApi;
}
