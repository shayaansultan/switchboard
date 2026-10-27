// http_ece (pulled in by web-push) ships no types, and none are published.
// The push test decrypts what web-push sent the way a phone would, so only
// the part it calls is declared.

declare module 'http_ece' {
  const ece: {
    decrypt(buffer: Buffer, params: object): Buffer;
  };
  export default ece;
}
