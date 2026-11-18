/** Only a matched browser cancellation of registered native transport is harmless.
 * Remotion 4's CDP ProtocolError retains originalMessage, but does not set code.
 */
export function isNativeTransportCancellation(input: {
  mediaProfile?: string;
  registeredAsset?: string;
  requestUrl: string;
  networkId?: string;
  canceledNetworkId?: string;
  canceled?: boolean;
  cancellation?: string;
  error: unknown;
}) {
  if (
    input.mediaProfile !== "native-local-media-v1" ||
    !input.registeredAsset ||
    !input.networkId ||
    input.networkId !== input.canceledNetworkId ||
    input.canceled !== true ||
    input.cancellation !== "net::ERR_ABORTED"
  )
    return false;
  try {
    const url = new URL(input.requestUrl);
    if (
      url.origin !== "https://avc.invalid" ||
      url.search ||
      url.hash ||
      decodeURIComponent(url.pathname.slice(1)) !== input.registeredAsset
    )
      return false;
  } catch {
    return false;
  }
  const error = input.error;
  return (
    error instanceof Error &&
    error.name === "ProtocolError" &&
    error.message === "Protocol error (Fetch.fulfillRequest): Invalid InterceptionId." &&
    "originalMessage" in error &&
    error.originalMessage === "Invalid InterceptionId."
  );
}
