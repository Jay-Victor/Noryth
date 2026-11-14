/**
 * PHASE-05 交付物路径：`tests/fixtures/slice/fake-adapter.ts`。
 *
 * 实现在 `src/main/slice/fake-adapter.ts`——它必须能被未打包的主进程直接引用，
 * 不能反向依赖 tests/。这里只是给测试与文档一个固定入口。
 */
export {
  FakeSliceModelAdapter,
  createFakeSliceAdapter,
  type FakeSliceModelOptions
} from '../../../src/main/slice/fake-adapter'
