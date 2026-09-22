// The preload bridge, exposed on the window by preload.ts.
interface Window {
  sb: import('../types').SwitchboardApi;
}
