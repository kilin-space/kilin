declare module "fs-native-extensions" {
  export function tryLock(fileDescriptor: number): boolean;
  export function waitForLockSync(fileDescriptor: number): void;
  export function unlock(fileDescriptor: number): void;
}
