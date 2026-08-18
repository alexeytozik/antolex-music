type PlaybackActivationHandler = (externalID: string) => void;

let playbackActivationHandler: PlaybackActivationHandler | null = null;

export function registerPlaybackActivationHandler(
  handler: PlaybackActivationHandler,
) {
  playbackActivationHandler = handler;
  return () => {
    if (playbackActivationHandler === handler) playbackActivationHandler = null;
  };
}

export function requestPlaybackActivation(externalID: string) {
  playbackActivationHandler?.(externalID);
}
