export {
  REMOTE_PROTOCOL_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  RemoteProtocolError,
} from "./protocol.js";
export type {
  RefsListRequest,
  RefsListResponse,
  RemoteRef,
  ObjectsMissingRequest,
  ObjectsMissingResponse,
  UploadLine,
  ObjectsUploadResponse,
  ObjectsDownloadRequest,
  RefsUpdateRequest,
  RefsUpdateResponse,
  RemoteError,
} from "./protocol.js";

export { RemoteClient } from "./client.js";
export type { RemoteClientOptions, FetchLike } from "./client.js";

export {
  pushSession,
  fetchRefs,
  pullRef,
  remoteStateFilePath,
} from "./sync.js";
export type {
  PushOptions,
  PushResult,
  FetchOptions,
  FetchResult,
  PullOptions,
  PullResult,
  RemoteUploadState,
  RemoteStateFile,
} from "./sync.js";
