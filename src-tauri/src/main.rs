// 发布构建时隐藏 Windows 控制台窗口；调试构建保留控制台便于查看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Tauri v2 可执行入口。
///
/// 逻辑全部位于 `app_lib`（Cargo.toml 中 `[lib] name = "app_lib"`），
/// 这里只是最薄的一层引导，便于后续补充单元测试与多平台复用。
fn main() {
    app_lib::run();
}