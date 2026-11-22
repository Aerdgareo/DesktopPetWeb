//! DesktopPetTauri —— Tauri v2 外壳库入口。
//!
//! # 职责
//! 1. 创建「透明 / 无边框 / 置顶」的桌宠窗口，加载前端 `../web`；
//! 2. 提供系统托盘（显示、切换置顶、退出）；
//! 3. 暴露 IPC 命令，与前端 `web/src/bridge.js` 的契约保持一致：
//!    `set_interactive` / `set_always_on_top` / `quit`
//!    以及窗口操作类 `move_window` / `set_visible` / `toggle_visible` / `poll_cursor`。
//!
//! # 关于「逐区鼠标穿透」的说明（重要）
//! Tauri v2 的 `setIgnoreCursorEvents` **没有** Electron 那种 `forward` 语义，
//! 无法在「穿透时仍把鼠标位置转发给 WebView」。因此采用如下推荐联动方案：
//!
//! * 前端在「可交互」状态下以约 30fps 轮询 [`poll_cursor`]（由 Rust 读取窗口内
//!   光标位置），自行判断光标是否落在模型/UI 命中区域内；
//! * 命中 → `invoke('set_interactive', { interactive: true })`（关闭穿透）；
//! * 未命中 → `invoke('set_interactive', { interactive: false })`（整窗穿透）。
//!
//! 这样把「命中几何」交给最了解坐标的前端，而 Rust 只负责读取光标与切换穿透，
//! 逻辑简单、跨平台且可回退。限制详见 `tauri/README.md`。

use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

/// 主窗口 label；窗口命令、托盘与能力集均以它为目标（见 `capabilities/default.json`）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 窗口初始尺寸（逻辑像素，与 `tauri.conf.json` 的 `app.windows[]` 保持一致）。
const PET_WINDOW_WIDTH: f64 = 420.0;
const PET_WINDOW_HEIGHT: f64 = 720.0;

/// 窗口置顶状态变化事件名；前端可用 `listen('always-on-top-changed', ...)` 订阅。
const EVENT_ALWAYS_ON_TOP_CHANGED: &str = "always-on-top-changed";

// ---------------------------------------------------------------------------
// IPC 命令
// ---------------------------------------------------------------------------

/// 切换「整窗穿透 / 可交互」。
///
/// * `interactive = true`  → 关闭穿透（`set_ignore_cursor_events(false)`），窗口接收鼠标；
/// * `interactive = false` → 开启穿透（`set_ignore_cursor_events(true)`），鼠标事件下传。
///
/// 前端调用：`invoke('set_interactive', { interactive: true })`。
#[tauri::command]
fn set_interactive(window: WebviewWindow, interactive: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(!interactive)
        .map_err(|e| format!("set_ignore_cursor_events failed: {e}"))
}

/// 切换窗口置顶，并广播 [`EVENT_ALWAYS_ON_TOP_CHANGED`] 事件供各端同步状态。
///
/// 前端调用：`invoke('set_always_on_top', { enabled: true })`。
#[tauri::command]
fn set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|e| format!("set_always_on_top failed: {e}"))?;
    let _ = window.emit(EVENT_ALWAYS_ON_TOP_CHANGED, enabled);
    Ok(())
}

/// 退出应用（等价于托盘「退出」）。
///
/// 前端调用：`invoke('quit')`。
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// 移动窗口：支持「相对偏移」与「绝对定位」两种调用方式。
///
/// * 相对：`invoke('move_window', { dx, dy })`
/// * 绝对：`invoke('move_window', { x, y })`
///
/// 传入的坐标单位为逻辑像素；`x`/`y` 优先级高于 `dx`/`dy`。
#[tauri::command]
fn move_window(
    window: WebviewWindow,
    dx: Option<f64>,
    dy: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current = window.outer_position().map_err(|e| e.to_string())?;

    // 统一换算为逻辑像素后计算目标位置，再还原为物理像素写入。
    let current_x = current.x as f64 / scale;
    let current_y = current.y as f64 / scale;

    let target_x = x.unwrap_or(current_x + dx.unwrap_or(0.0));
    let target_y = y.unwrap_or(current_y + dy.unwrap_or(0.0));

    window
        .set_position(tauri::PhysicalPosition::new(target_x * scale, target_y * scale))
        .map_err(|e| format!("set_position failed: {e}"))
}

/// 显示 / 隐藏窗口。前端调用：`invoke('set_visible', { visible: true })`。
#[tauri::command]
fn set_visible(window: WebviewWindow, visible: bool) -> Result<(), String> {
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|e| format!("set_visible failed: {e}"))
}

/// 切换窗口可见性。前端调用：`invoke('toggle_visible')`。
#[tauri::command]
fn toggle_visible(window: WebviewWindow) -> Result<(), String> {
    let visible = window.is_visible().unwrap_or(true);
    if visible {
        window.hide()
    } else {
        window.show()
    }
    .map_err(|e| format!("toggle_visible failed: {e}"))
}

/// 窗口内光标位置（逻辑像素 + 物理像素）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorPosition {
    /// 相对窗口左上角的逻辑像素 X。
    x: f64,
    /// 相对窗口左上角的逻辑像素 Y。
    y: f64,
    /// 相对窗口左上角的物理像素 X。
    physical_x: f64,
    /// 相对窗口左上角的物理像素 Y。
    physical_y: f64,
}

/// 读取当前光标在窗口内的位置（相对窗口左上角）。
///
/// 供前端以约 30fps 轮询、实现「逐区穿透」命中判定：
/// 返回 `null` 表示当前无法读取（例如光标不在本窗口/系统拒绝查询），
/// 此时前端宜退化为「整窗穿透」，避免窗口意外吸附鼠标。
///
/// 前端调用：`const pos = await invoke('poll_cursor');`
#[tauri::command]
fn poll_cursor(window: WebviewWindow) -> Result<Option<CursorPosition>, String> {
    match window.cursor_position() {
        Ok(pos) => {
            let scale = window.scale_factor().unwrap_or(1.0);
            Ok(Some(CursorPosition {
                x: pos.x / scale,
                y: pos.y / scale,
                physical_x: pos.x,
                physical_y: pos.y,
            }))
        }
        // 读取失败不是致命错误：返回 None，让前端降级处理。
        Err(_) => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 模型目录 / 外部模型地址（与前端 bridge.js 契约一致）
// ---------------------------------------------------------------------------
//
// 与 Electron 外壳对齐：外部模型地址（可多个）持久化在应用配置目录的 config.json，
// 形如 `{ "externalModels": [{ "id": "r1", "path": "D:\\models" }, ...] }`；
// `get_model_list` 扫描各外部根的一级子目录、发现 Live2D 入口文件（.model3.json /
// .model.json）后返回清单；模型 url 为入口文件的绝对路径，前端经 asset 协议
// （window.__TAURI__.core.convertFileSrc）转换为 WebView 可加载 URL，
// 从而像内置 models/ 一样加载外部模型及其相对资源（贴图 / 动作 / 物理等）。

/// 外部模型地址条目：`id` 为稳定标识（r1/r2…），`path` 为磁盘绝对路径。
#[derive(Debug, Clone, Serialize)]
struct ExternalDir {
    id: String,
    path: String,
}

/// 模型清单条目（与前端 normalizeList 兼容：`type` 为运行时版本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelEntry {
    id: String,
    name: String,
    url: String,
    #[serde(rename = "type")]
    model_type: String,
    source: String,
}

/// 配置文件绝对路径（应用配置目录下 config.json）。
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    Ok(dir.join("config.json"))
}

/// 规整外部地址路径：去首尾空白、去尾部斜杠 / 反斜杠；裸盘符（`D:`）补回分隔符。
fn normalize_root_path(p: &str) -> String {
    let mut s = p.trim().to_string();
    if s.is_empty() {
        return s;
    }
    while s.ends_with('\\') || s.ends_with('/') {
        s.pop();
    }
    // 仅剩盘符（如 `D:`）时补回根分隔符，避免被误判为相对路径
    if s.len() == 2 && s.as_bytes()[1] == b':' {
        s.push(std::path::MAIN_SEPARATOR);
    }
    s
}

/// 解析稳定 id（`r<n>`）中的序号；非该形式返回 None。
fn parse_root_id(id: &str) -> Option<u32> {
    id.strip_prefix('r').and_then(|n| n.parse::<u32>().ok())
}

/// 规整外部地址数组：校验、按 path 去重、补齐缺失 / 冲突的稳定 id（r<n>）。
fn normalize_roots(items: Vec<ExternalDir>) -> Vec<ExternalDir> {
    let mut out: Vec<ExternalDir> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut used_ids: HashSet<String> = HashSet::new();
    let mut max_id: u32 = 0;

    for it in items {
        let np = normalize_root_path(&it.path);
        if np.is_empty() {
            continue;
        }
        let key = np.to_lowercase();
        if !seen_paths.insert(key) {
            continue;
        }
        let mut id = it.id.trim().to_string();
        if !id.is_empty() {
            if let Some(n) = parse_root_id(&id) {
                max_id = max_id.max(n);
            }
            if used_ids.contains(&id) {
                id.clear();
            }
        }
        if !id.is_empty() {
            used_ids.insert(id.clone());
        }
        out.push(ExternalDir { id, path: np });
    }

    // 为缺失 / 冲突的项分配稳定新 id
    for item in out.iter_mut() {
        if !item.id.is_empty() {
            continue;
        }
        loop {
            max_id += 1;
            let cand = format!("r{max_id}");
            if !used_ids.contains(&cand) {
                item.id = cand.clone();
                used_ids.insert(cand);
                break;
            }
        }
    }
    out
}

/// 追加一个外部地址（按 path 去重，大小写不敏感）；已存在则保持不变。
fn add_root(roots: &mut Vec<ExternalDir>, p: &str) {
    let np = normalize_root_path(p);
    if np.is_empty() {
        return;
    }
    let key = np.to_lowercase();
    if roots.iter().any(|r| r.path.to_lowercase() == key) {
        return;
    }
    let mut max = 0u32;
    for r in roots.iter() {
        if let Some(n) = parse_root_id(&r.id) {
            max = max.max(n);
        }
    }
    let mut n = max + 1;
    let mut id = format!("r{n}");
    while roots.iter().any(|r| r.id == id) {
        n += 1;
        id = format!("r{n}");
    }
    roots.push(ExternalDir { id, path: np });
}

/// 删除一个外部地址（先按稳定 id，再按 path 匹配）；返回是否实际删除。
fn remove_root(roots: &mut Vec<ExternalDir>, key: &str) -> bool {
    if key.trim().is_empty() {
        return false;
    }
    if let Some(idx) = roots.iter().position(|r| r.id == key) {
        roots.remove(idx);
        return true;
    }
    let nk = normalize_root_path(key).to_lowercase();
    if let Some(idx) = roots.iter().position(|r| r.path.to_lowercase() == nk) {
        roots.remove(idx);
        return true;
    }
    false
}

/// 读取完整配置文档（`config.json`）。
///
/// 契约（`C-CONFIG@1`）：文件缺失 / 无法读取 / JSON 解析失败 / 顶层不是对象时，
/// 统一返回空对象 `{}`，**绝不 panic、绝不向调用者抛错**。
/// 其它未知键原样保留，供向前兼容使用。
fn load_config_doc(app: &AppHandle) -> JsonValue {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return JsonValue::Object(serde_json::Map::new()),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return JsonValue::Object(serde_json::Map::new()),
    };
    match serde_json::from_str::<JsonValue>(&raw) {
        Ok(v) if v.is_object() => v,
        // 损坏 / 顶层非对象：视为空配置（不覆盖用户其它键的前提是下次写入合并）
        _ => JsonValue::Object(serde_json::Map::new()),
    }
}

/// 写回完整配置文档（read-modify-write 的落点）：确保父目录存在，pretty 化写出。
fn save_config_doc(app: &AppHandle, doc: &JsonValue) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(doc).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入配置失败: {e}"))
}

/// 读取外部地址列表（RMW 读取；文件缺失 / 损坏 → 空列表，绝不抛错）。
fn load_external_roots(app: &AppHandle) -> Vec<ExternalDir> {
    let doc = load_config_doc(app);
    let arr = doc
        .get("externalModels")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let items: Vec<ExternalDir> = arr
        .into_iter()
        .filter_map(|v| {
            let path = v.get("path").and_then(|p| p.as_str()).unwrap_or_default();
            let id = v.get("id").and_then(|i| i.as_str()).unwrap_or_default();
            if path.trim().is_empty() {
                None
            } else {
                Some(ExternalDir {
                    id: id.to_string(),
                    path: path.to_string(),
                })
            }
        })
        .collect();
    normalize_roots(items)
}

/// 写回外部地址列表（RMW：仅替换 `externalModels`，其余键（含 `importRoot`）原样保留）。
fn save_external_roots(app: &AppHandle, roots: &[ExternalDir]) -> Result<(), String> {
    let mut doc = load_config_doc(app);
    if !doc.is_object() {
        doc = JsonValue::Object(serde_json::Map::new());
    }
    let list: Vec<JsonValue> = roots
        .iter()
        .map(|r| serde_json::json!({ "id": r.id, "path": r.path }))
        .collect();
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("externalModels".to_string(), JsonValue::Array(list));
    }
    save_config_doc(app, &doc)
}

/// 读取导入根目录（`config.json` 的 `importRoot`）。
///
/// 空串 / 缺失 / 非字符串 / 仅空白 → `None`（统一表示「未设置」，落点回退 exe 同级 `models/`）。
/// 返回值为 [`normalize_root_path`] 归一化后的绝对路径；不校验目录是否仍然存在。
fn read_import_root(app: &AppHandle) -> Option<String> {
    let doc = load_config_doc(app);
    let raw = doc
        .get("importRoot")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let normalized = normalize_root_path(raw);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// 写入导入根目录（RMW：仅替换 `importRoot`，`externalModels` 与未知键原样保留）。
///
/// `None` / 归一化后为空 → 存为 `null`（语义：恢复默认落点）。
/// 返回实际写入的归一化值；写入失败返回 `Err` 且磁盘配置保持原样。
fn write_import_root(app: &AppHandle, value: Option<&str>) -> Result<Option<String>, String> {
    let mut doc = load_config_doc(app);
    if !doc.is_object() {
        doc = JsonValue::Object(serde_json::Map::new());
    }
    let normalized = value
        .map(normalize_root_path)
        .filter(|s| !s.is_empty());
    let payload = match &normalized {
        Some(p) => JsonValue::String(p.clone()),
        None => JsonValue::Null,
    };
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("importRoot".to_string(), payload);
    }
    save_config_doc(app, &doc)?;
    Ok(normalized)
}

/// 依据入口文件名判定 Live2D 运行时版本。
fn detect_model_type(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".model.json") {
        "Cubism2".to_string()
    } else {
        "Cubism4".to_string()
    }
}

/// 在模型目录中查找入口文件（优先 .model3.json，其次 .model.json）。
fn find_entry_file(dir: &Path) -> Option<(String, String)> {
    let rd = fs::read_dir(dir).ok()?;
    let mut fallback: Option<(String, String)> = None;
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let lower = name.to_lowercase();
        if lower.ends_with(".model3.json") {
            return Some((name.clone(), detect_model_type(&name)));
        }
        if lower.ends_with(".model.json") {
            fallback = Some((name.clone(), detect_model_type(&name)));
        }
    }
    fallback
}

/// 扫描一个模型根的一级子目录，返回发现的模型条目（url 为入口文件绝对路径）。
fn scan_models_in_root(root: &Path, source: &str) -> Vec<ModelEntry> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out, // 根不存在 / 无权限 → 跳过该根
    };
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = match dir.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if let Some((file_name, kind)) = find_entry_file(&dir) {
            let abs = dir.join(&file_name);
            out.push(ModelEntry {
                id: dir_name.clone(),
                // 显示层净化：去 Cubism 型号 / 尾部分版本号，但保留 ` (n)` 冲突序号；
                // 磁盘目录名（id）与 url 不变，历史目录不改名。
                name: derive_display_name(&dir_name),
                url: abs.to_string_lossy().to_string(),
                model_type: kind,
                source: source.to_string(),
            });
        }
    }
    out
}

/// 读取全部外部模型地址。前端 `invoke('get_external_models_dirs')`。
#[tauri::command]
fn get_external_models_dirs(app: AppHandle) -> Vec<ExternalDir> {
    load_external_roots(&app)
}

/// 选择「外部模型文件夹」：弹原生目录选择器 → 追加并持久化 → 返回全部地址。
/// 前端 `invoke('pick_external_models_dir')`；取消时返回当前地址数组（未变更）。
///
/// 关键：传入 `window` 并经 [`set_parent`] 指定父窗口 —— 桌宠是「置顶 + 无边框 +
/// 全屏透明」窗口，若对话框无父窗口，会被置顶的桌宠窗口压在下层/失去焦点，
/// 用户会误以为「点了没反应」。绑定 owner 后对话框将显示在桌宠窗口之上。
#[tauri::command]
async fn pick_external_models_dir(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<ExternalDir>, String> {
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("选择外部模型文件夹")
        .blocking_pick_folder();
    if let Some(fp) = picked {
        let p = fp.to_string();
        let mut roots = load_external_roots(&app);
        add_root(&mut roots, &p);
        save_external_roots(&app, &roots)?;
    }
    Ok(load_external_roots(&app))
}

/// 删除指定外部地址（入参为稳定 id 或绝对路径）。
/// 前端 `invoke('remove_external_models_dir', { idOrPath })`。
#[tauri::command]
fn remove_external_models_dir(app: AppHandle, id_or_path: String) -> Vec<ExternalDir> {
    let mut roots = load_external_roots(&app);
    remove_root(&mut roots, &id_or_path);
    let _ = save_external_roots(&app, &roots);
    roots
}

/// 清空全部外部地址。前端 `invoke('clear_external_models_dirs')`。
#[tauri::command]
fn clear_external_models_dirs(app: AppHandle) -> bool {
    save_external_roots(&app, &[]).is_ok()
}

// ---------------------------------------------------------------------------
// 导入根目录（`config.json` 的 importRoot，契约 C-IMPORT-ROOT@1）
// ---------------------------------------------------------------------------

/// 读取当前导入根目录。前端 `invoke('get_import_root')`。
///
/// 返回 `null` 表示未设置（导入落点回退到 exe 同级 `models/`）。
/// 不校验目录是否仍然存在：删除目录后仍能读到值，由导入时报错。
#[tauri::command]
fn get_import_root(app: AppHandle) -> Option<String> {
    read_import_root(&app)
}

/// 选择「模型导入根目录」：弹原生目录选择器 → 持久化到 `config.json.importRoot`。
/// 前端 `invoke('pick_import_root')`。
///
/// * 取消（用户未选）→ 返回当前值，不写配置、不报错；
/// * 写入失败 → `Err("保存导入根目录失败: <e>")`，磁盘配置保持原样。
///
/// 关键：传入 `window` 并经 [`set_parent`] 指定父窗口，否则在「置顶 + 无边框 + 全屏透明」
/// 的桌宠窗口下对话框会被遮挡 / 失焦（同 [`pick_external_models_dir`]）。
#[tauri::command]
async fn pick_import_root(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("选择模型导入根目录")
        .blocking_pick_folder();
    match picked {
        Some(fp) => write_import_root(&app, Some(&fp.to_string()))
            .map_err(|e| format!("保存导入根目录失败: {e}")),
        // 取消：不写配置，返回当前值（前端据此保持显示不变）
        None => Ok(read_import_root(&app)),
    }
}

/// 清空导入根目录（恢复默认落点 `<exe_dir>/models`）。
/// 前端 `invoke('clear_import_root')`；成功恒返回 `null`。
///
/// 只清配置，**不删除、不迁移**任何已存在的模型目录。
#[tauri::command]
fn clear_import_root(app: AppHandle) -> Result<Option<String>, String> {
    write_import_root(&app, None)
}

/// 读取模型清单：扫描「程序 models/（导入落点）」＋「全部外部模型根」。
/// 内置 models/（随前端分发）清单由前端读 models.json 合并，不在此处扫描。
/// 前端 `invoke('get_model_list')`，返回 [{ id, name, url, type, source }]。
#[tauri::command]
fn get_model_list(app: AppHandle) -> Vec<ModelEntry> {
    let mut out: Vec<ModelEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1) 程序目录（exe 同级 models/）：默认导入落点；source='imported'（前端据此显示「删除」）
    if let Ok(dir) = exe_models_dir() {
        for m in scan_models_in_root(&dir, "imported") {
            if seen.insert(m.url.clone()) {
                out.push(m);
            }
        }
    }

    // 2) 导入根目录（用户设置的全局导入落点）：语义同为「已导入」，可删除；
    //    若与程序 models/ 是同一目录，靠 url 去重避免重复条目。
    if let Some(root) = read_import_root(&app) {
        for m in scan_models_in_root(Path::new(&root), "imported") {
            if seen.insert(m.url.clone()) {
                out.push(m);
            }
        }
    }

    // 3) 已引用的外部模型文件夹（多根）：source='external'（不可删除）
    for root in load_external_roots(&app) {
        if root.path.trim().is_empty() {
            continue;
        }
        for m in scan_models_in_root(Path::new(&root.path), "external") {
            if seen.insert(m.url.clone()) {
                out.push(m);
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// 模型库：导入 / 删除（契约 C-MODEL-NAMING@1）
// ---------------------------------------------------------------------------
//
// 单 exe「绿色版」约定：模型库根 = `importRoot`（用户在设置面板配置的全局导入根目录）；
// 未设置时回退为**可执行文件同级**的 `models/`。
//   * 导入：把选中的模型目录递归复制到 `<模型库根>/<基本模型名>/`；
//     基本模型名去版本号/型号后缀；同名但来源不同则新建 `<基本名> (2)`…（**不覆盖、不删除**）；
//     重复导入同一源目录则幂等复用；
//   * 列表：`get_model_list` 扫描「exe models/ → importRoot → 各外部根」（source='imported'/'external'，
//     按 url 去重）→ 导入后立即出现在列表；
//   * 删除：删除模型库根（或外部根）内的模型目录，带安全边界校验。

/// 程序目录（exe 同级）的 models 目录：`<exe_dir>/models`。
fn exe_models_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取可执行文件路径失败: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法解析可执行文件所在目录".to_string())?;
    Ok(dir.join("models"))
}

/// 递归复制目录（保留子目录与全部伴随资源：贴图 / 动作 / 物理 / 表情等）。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 生成安全的模型文件夹名：移除 Windows 非法字符与控制字符、去首尾空白 / 点，
/// 内部连续空白压缩为单个连字符；保留中文等 Unicode 字符。空则兜底为 `model`。
fn sanitize_model_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .filter(|c| !c.is_control())
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join("-");
    s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.chars().count() > 40 {
        s = s.chars().take(40).collect();
        s = s.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    }
    if s.is_empty() {
        s = "model".to_string();
    }
    s
}

/// 模型名允许的最大字符数（含同名序号后缀，见 [`resolve_import_target_dir`]）。
const MAX_MODEL_NAME_LEN: usize = 44;

/// Windows 资源管理器「复制」产生的同名序号后缀允许的最大位数（`(1)`…`(999)`）。
const COPY_SUFFIX_MAX_DIGITS: usize = 3;

/// 判断尾部片段是否是 Cubism 型号标记（大小写不敏感）：
/// `cubism2` / `cubism3` / `cubism4` / `cubism5`。
fn is_cubism_marker(seg: &str) -> bool {
    matches!(
        seg.to_lowercase().as_str(),
        "cubism2" | "cubism3" | "cubism4" | "cubism5"
    )
}

/// 判断尾部片段是否是版本号：可选 `v`/`V` 前缀 + 数字 + 可选 `.数字` 重复。
///
/// 例：`2`、`03`、`v2`、`V1.0`、`1.2.3` 均匹配；`t03`（字母+数字）、`v`、`1.` 不匹配。
fn is_version_segment(seg: &str) -> bool {
    let body = seg
        .strip_prefix('v')
        .or_else(|| seg.strip_prefix('V'))
        .unwrap_or(seg);
    if body.is_empty() {
        return false;
    }
    let mut parts = body.split('.');
    let first = parts.next().unwrap_or_default();
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if !digits(first) {
        return false;
    }
    parts.all(digits)
}

/// 循环移除「尾部分隔符 + 符合 predicate 的片段」。
///
/// 分隔符固定为 `-` / `_` / 空格（净化后空格通常已变成 `-`，保留空格以兼容磁盘既有目录名）。
/// 仅当片段非空且 `predicate(片段)` 为真时才截断，因此 `haru_greeter_t03` 的 `t03` 不会被误伤。
fn strip_tail_segments<F>(name: &str, predicate: F) -> String
where
    F: Fn(&str) -> bool,
{
    let mut cur = name.to_string();
    loop {
        let trimmed = cur.trim_end_matches(|c| c == '.' || c == ' ');
        if trimmed.len() != cur.len() {
            cur = trimmed.to_string();
        }
        let Some(pos) = cur.rfind(|c: char| matches!(c, '-' | '_' | ' ')) else {
            break;
        };
        let seg = &cur[pos + 1..];
        if !seg.is_empty() && predicate(seg) {
            cur.truncate(pos);
            continue;
        }
        break;
    }
    cur
}

/// 移除尾部的 Windows「复制」后缀：` (1)` / `(2)` / `（2）`，允许前面有 `-` / `_` / 空格。
///
/// 注意：入参通常已过 [`sanitize_model_name`]，其中的空格已被压缩成 `-`，
/// 因此 `foo (1)` 实际以 `foo-(1)` 形式出现，需同时兼容 `foo(1)` 写法。
fn strip_copy_suffix(name: &str) -> String {
    let mut cur = name.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    loop {
        let mut stripped: Option<String> = None;
        for (open, close) in [('(', ')'), ('（', '）')] {
            if !cur.ends_with(close) {
                continue;
            }
            let Some(idx) = cur.rfind(open) else {
                continue;
            };
            let inner = &cur[idx + open.len_utf8()..cur.len() - close.len_utf8()];
            let is_copy_index = !inner.is_empty()
                && inner.len() <= COPY_SUFFIX_MAX_DIGITS
                && inner.chars().all(|c| c.is_ascii_digit());
            if !is_copy_index {
                continue;
            }
            let head = cur[..idx].trim_end_matches(|c| c == '-' || c == '_' || c == ' ');
            if !head.is_empty() {
                stripped = Some(head.to_string());
                break;
            }
        }
        match stripped {
            Some(s) => cur = s,
            None => break,
        }
    }
    cur
}

/// 导入目标目录名（`C-MODEL-NAMING@1`）：在 [`sanitize_model_name`] 基础上继续去除
/// 尾部 Cubism 型号、Windows 复制后缀与版本号；空 → `model`。
///
/// 验收例：`lafei_4`→`lafei`、`aierdeliqi_5`→`aierdeliqi`、`肥牛-cubism4`→`肥牛`、
/// `x-v1.2`→`x`、`foo (1)`→`foo`；`haru_greeter_t03` 保持不变（不误伤）。
fn derive_base_model_name(raw: &str) -> String {
    let mut cur = sanitize_model_name(raw);
    for _ in 0..8 {
        let before = cur.clone();
        cur = strip_copy_suffix(&cur);
        cur = strip_tail_segments(&cur, is_cubism_marker);
        cur = strip_tail_segments(&cur, is_version_segment);
        cur = cur.trim_matches(|c| c == '.' || c == ' ').to_string();
        if cur.is_empty() {
            cur = "model".to_string();
        }
        if cur == before {
            break;
        }
    }
    if cur.is_empty() {
        "model".to_string()
    } else {
        cur
    }
}

/// 列表显示名（`C-MODEL-NAMING@1`）：仅去 Cubism 型号与尾部分版本号，
/// **保留** ` (n)` 冲突序号（用于区分同名的多个副本）。
///
/// 输入为磁盘目录名原样（不做 sanitize），因此 `lafei (2)` 保持为 `lafei (2)`。
fn derive_display_name(dir_name: &str) -> String {
    let mut cur = dir_name.trim().to_string();
    for _ in 0..8 {
        let before = cur.clone();
        cur = strip_tail_segments(&cur, is_cubism_marker);
        cur = strip_tail_segments(&cur, is_version_segment);
        cur = cur.trim_matches(|c| c == '.' || c == ' ').to_string();
        if cur == before {
            break;
        }
    }
    if cur.is_empty() {
        "model".to_string()
    } else {
        cur
    }
}

/// 判断字符串是否更像「磁盘路径」而非「模型 id」（含路径分隔符或为绝对路径）。
fn looks_like_path(s: &str) -> bool {
    s.contains('\\') || s.contains('/') || Path::new(s).is_absolute()
}

/// 判断 `child` 是否位于 `parent` 之内（删除安全校验用；两者需真实存在）。
fn is_within(child: &Path, parent: &Path) -> bool {
    match (child.canonicalize(), parent.canonicalize()) {
        (Ok(c), Ok(p)) => c.starts_with(&p),
        _ => false,
    }
}

/// 判断两个路径是否指向同一物理目录（无法规范化时退化为大小写不敏感的字符串比较）。
fn dirs_equal(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase(),
    }
}

/// 选择实际落点目录（`C-MODEL-NAMING@1`）：**不覆盖、不删除**既有目录。
///
/// * `root` —— 目标根（`importRoot` 或 exe 同级 `models/`）；
/// * `src`  —— 本次导入的源模型目录（已定位）；
/// * `base` —— [`derive_base_model_name`] 的结果。
///
/// 决策（与计划 2.2.3 决策表一致）：
/// 1. `root/base` 不存在 → `(root/base, base)`；
/// 2. 存在且与 `src` 是同一物理目录 → `(root/base, base)`（幂等复用，调用方不得复制/删除）；
/// 3. 存在但来源不同 → 取 `"base (2)"` … `"base (99)"` 中第一个不存在者；
/// 4. 全部占用 → `Err`；加序号前先把 `base` 截断到 44 字符上限内。
fn resolve_import_target_dir(
    root: &Path,
    src: &Path,
    base: &str,
) -> Result<(PathBuf, String), String> {
    let base = if base.trim().is_empty() { "model" } else { base.trim() };
    let direct = root.join(base);
    if !direct.exists() {
        return Ok((direct, base.to_string()));
    }
    if dirs_equal(src, &direct) {
        return Ok((direct, base.to_string()));
    }

    // 保证 `base (nn)` 总长不超过 MAX_MODEL_NAME_LEN（Windows 可用性）
    let suffix_budget = " (99)".chars().count();
    let max_base_len = MAX_MODEL_NAME_LEN.saturating_sub(suffix_budget);
    let truncated: String = if base.chars().count() > max_base_len {
        base.chars()
            .take(max_base_len)
            .collect::<String>()
            .trim_end_matches(|c| c == '.' || c == ' ' || c == '-' || c == '_')
            .to_string()
    } else {
        base.to_string()
    };
    let truncated = if truncated.is_empty() {
        "model".to_string()
    } else {
        truncated
    };

    for n in 2..=99u32 {
        let cand_name = format!("{truncated} ({n})");
        let cand = root.join(&cand_name);
        if !cand.exists() {
            return Ok((cand, cand_name));
        }
    }
    Err("同名模型过多（已存在 base (2)…(99)）".to_string())
}

/// 从「入口文件」或「模型目录」解析出模型目录（含一级 .model3.json / .model.json）。
/// 返回 (模型目录, 入口文件名, 运行时类型)。
fn locate_model_dir(p: &Path) -> Result<(PathBuf, String, String), String> {
    if p.is_file() {
        let dir = p
            .parent()
            .ok_or_else(|| "无法解析模型所在目录".to_string())?
            .to_path_buf();
        let file_name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let kind = detect_model_type(&file_name);
        return Ok((dir, file_name, kind));
    }
    if p.is_dir() {
        if let Some((file_name, kind)) = find_entry_file(p) {
            return Ok((p.to_path_buf(), file_name, kind));
        }
        return Err("所选目录内未找到 Live2D 入口文件（*.model3.json / *.model.json）".to_string());
    }
    Err("所选路径不存在".to_string())
}

/// 导入模型：弹原生选择器 → 定位模型目录 → 按「基本模型名 + 同名不覆盖」复制到
/// `<模型库根>/<实际目录名>/` → 返回模型条目。
///
/// 模型库根 = `config.json` 的 `importRoot`；未设置时回退 `<exe_dir>/models`。
///
/// 前端 `invoke('import_model')`；用户取消返回 None。
/// 选择方式：优先「选文件夹」；若取消，再弹出「选入口文件」（Tauri 对话框无法同时选文件 / 文件夹）。
///
/// 关键：两次对话框均以桌宠窗口为 owner（[`set_parent`]），否则在「置顶 + 无边框 + 全屏透明」
/// 的桌宠窗口下，无主对话框会被遮挡 / 失焦，表现为「点了没反应」。
#[tauri::command]
async fn import_model(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<ModelEntry>, String> {
    let picked: Option<PathBuf> = match app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("选择 Live2D 模型文件夹")
        .blocking_pick_folder()
    {
        Some(dir) => Some(PathBuf::from(dir.to_string())),
        None => app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("选择 Live2D 模型入口文件（.model3.json / .model.json）")
            .add_filter("Live2D 模型", &["json"])
            .blocking_pick_file()
            .map(|f| PathBuf::from(f.to_string())),
    };
    let Some(selected) = picked else {
        return Ok(None); // 两次均取消 → 视为未导入
    };

    let (src_dir, entry_file, model_type) = locate_model_dir(&selected)?;

    // 基本模型名：源目录名去 Cubism 型号 / Windows 复制后缀 / 尾部分版本号
    let dir_name = src_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let base = derive_base_model_name(&dir_name);

    // 目标根：importRoot ?? <exe_dir>/models
    let models_root = match read_import_root(&app) {
        Some(p) => PathBuf::from(p),
        None => exe_models_dir()?,
    };
    fs::create_dir_all(&models_root).map_err(|e| format!("创建模型目录失败: {e}"))?;

    // 落点决策：不存在 → base；同一物理目录 → 幂等复用；来源不同 → base (2)…(99)
    let (dest, actual_name) = resolve_import_target_dir(&models_root, &src_dir, &base)?;

    // 幂等：源目录即目标目录（重复导入自身）→ 直接返回现有条目，不复制、不删除
    if dirs_equal(&src_dir, &dest) {
        let abs = dest.join(&entry_file);
        return Ok(Some(ModelEntry {
            id: actual_name.clone(),
            name: derive_display_name(&actual_name),
            url: abs.to_string_lossy().to_string(),
            model_type,
            source: "imported".to_string(),
        }));
    }

    copy_dir_all(&src_dir, &dest).map_err(|e| format!("复制模型失败: {e}"))?;

    let abs_entry = dest.join(&entry_file);
    Ok(Some(ModelEntry {
        id: actual_name.clone(),
        name: derive_display_name(&actual_name),
        url: abs_entry.to_string_lossy().to_string(),
        model_type,
        source: "imported".to_string(),
    }))
}

/// 删除模型：删除模型库根（exe `models/` 或 importRoot）或外部根内的模型目录。
///
/// 入参 `idOrPath` 可为模型 **id（目录名）** 或模型 **入口文件的绝对路径**（前端优先传 url）。
/// 安全：白名单 = 「程序 models/ 之下」∪「importRoot 之下」∪「已引用外部根之下」；越界返回错误。
/// 前端 `invoke('delete_model', { idOrPath })`；目标已不存在时返回 Ok(false)（幂等）。
#[tauri::command]
fn delete_model(app: AppHandle, id_or_path: String) -> Result<bool, String> {
    let key = id_or_path.trim();
    if key.is_empty() {
        return Err("缺少模型标识".to_string());
    }

    let exe_models = exe_models_dir()?;
    let import_root = read_import_root(&app).map(PathBuf::from);

    // 1) 解析目标模型目录
    let target = if looks_like_path(key) {
        let p = Path::new(key);
        if p.is_file() {
            p.parent()
                .map(|d| d.to_path_buf())
                .ok_or_else(|| "无法解析模型目录".to_string())?
        } else {
            p.to_path_buf()
        }
    } else {
        // 仅给目录名：优先程序 models/，其次 importRoot（两者都可能存在同名目录）
        let in_exe = exe_models.join(key);
        match import_root.as_ref().map(|r| r.join(key)) {
            Some(in_root) if !in_exe.exists() && in_root.exists() => in_root,
            _ => in_exe,
        }
    };

    if !target.exists() {
        return Ok(false); // 已不存在：视为已完成（幂等）
    }

    // 2) 安全校验：仅可删除程序 models/、importRoot 或任一已引用外部根之下的目录
    let roots = load_external_roots(&app);
    let allowed = is_within(&target, &exe_models)
        || import_root
            .as_ref()
            .map(|r| is_within(&target, r))
            .unwrap_or(false)
        || roots
            .iter()
            .any(|r| !r.path.is_empty() && is_within(&target, Path::new(&r.path)));
    if !allowed {
        return Err(
            "不允许删除该目录（仅可删除程序 models/、导入根目录或已引用外部文件夹内的模型）"
                .to_string(),
        );
    }

    // 3) 删除目录（被占用 / 失败时返回错误，由前端提示）
    fs::remove_dir_all(&target).map_err(|e| format!("删除模型目录失败: {e}"))?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘装配
// ---------------------------------------------------------------------------

/// 确保主窗口存在。
///
/// 优先复用 `tauri.conf.json` 中声明的窗口（`app.windows[]` 已配置
/// transparent / decorations=false / alwaysOnTop 等）；若配置未声明，
/// 则退化为以代码方式创建，属性与配置保持完全一致。
fn ensure_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // 幂等补齐运行时行为：置顶 + 初始可交互（穿透由前端命中判定后切换）。
        let _ = window.set_always_on_top(true);
        let _ = window.set_ignore_cursor_events(false);
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("DesktopPet")
    .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .build()
}

/// 构建系统托盘：显示桌宠 / 切换置顶 / 退出。
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示桌宠", true, None::<&str>)?;
    let toggle_top_item = MenuItem::with_id(app, "toggle_top", "切换置顶", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &toggle_top_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("DesktopPet")
        .menu(&menu)
        // 左键单击直接显示窗口，右键才弹出菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle_top" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let next = !window.is_always_on_top().unwrap_or(true);
                    let _ = window.set_always_on_top(next);
                    let _ = app.emit(EVENT_ALWAYS_ON_TOP_CHANGED, next);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });

    // 图标由 `tauri.conf.json` 的 bundle.icon 提供；缺省时优雅跳过（不 panic）。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 启动 Tauri 应用（由 `main.rs` 调用）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 原生文件 / 目录选择对话框（import_model / pick_external_models_dir）
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let _window = ensure_main_window(&handle)?;
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭按钮 → 收进托盘（桌宠常驻），而非退出应用。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW_LABEL {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_interactive,
            set_always_on_top,
            quit,
            move_window,
            set_visible,
            toggle_visible,
            poll_cursor,
            // 模型清单 / 外部模型地址（与 web/src/bridge.js 契约一致）
            get_external_models_dirs,
            pick_external_models_dir,
            remove_external_models_dir,
            clear_external_models_dirs,
            get_model_list,
            // 导入根目录（config.json 的 importRoot）
            get_import_root,
            pick_import_root,
            clear_import_root,
            // 导入 / 删除模型（模型库根 = importRoot ?? exe 同级 models/）
            import_model,
            delete_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running DesktopPet (Tauri) application");
}

// ---------------------------------------------------------------------------
// 单元测试：仅覆盖纯函数（命名净化 / 落点决策），不触碰 Tauri 运行时
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 每个测试独占一个临时目录；Drop 时递归清理。
    struct TempDir(PathBuf);

    impl TempDir {
        /// 创建 `<系统临时目录>/desktop-pet-ut-<tag>-<pid>-<序号>-<时间戳>`。
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let mut p = std::env::temp_dir();
            p.push(format!(
                "desktop-pet-ut-{tag}-{}-{n}-{stamp}",
                std::process::id()
            ));
            fs::create_dir_all(&p).expect("创建临时测试目录失败");
            TempDir(p)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // ---- derive_base_model_name：计划 acceptance ② ----

    #[test]
    fn base_name_strips_version_copy_suffix_and_cubism_marker() {
        assert_eq!(derive_base_model_name("lafei_4"), "lafei");
        assert_eq!(derive_base_model_name("aierdeliqi_5"), "aierdeliqi");
        assert_eq!(derive_base_model_name("肥牛-cubism4"), "肥牛");
        assert_eq!(derive_base_model_name("x-v1.2"), "x");
        assert_eq!(derive_base_model_name("foo (1)"), "foo");
        assert_eq!(derive_base_model_name("foo (2)"), "foo");
        // 多段尾部成分需循环剥离：先去复制后缀 → 去型号 → 去版本号
        assert_eq!(derive_base_model_name("lafei_4 (1)"), "lafei");
        assert_eq!(derive_base_model_name("初心_1.0-cubism4"), "初心");
        // 空 / 纯空白 → model
        assert_eq!(derive_base_model_name(""), "model");
        assert_eq!(derive_base_model_name("   "), "model");
    }

    #[test]
    fn base_name_keeps_letter_digit_tail() {
        // 反向用例：`t03` 是字母+数字，不是版本号，不得误伤
        assert_eq!(
            derive_base_model_name("haru_greeter_t03"),
            "haru_greeter_t03"
        );
    }

    // ---- derive_display_name：计划 acceptance ③ ----

    #[test]
    fn display_name_keeps_copy_suffix_but_strips_version_marker() {
        assert_eq!(derive_display_name("lafei (2)"), "lafei (2)");
        assert_eq!(derive_display_name("lafei (1)"), "lafei (1)");
        assert_eq!(derive_display_name("lafei_4"), "lafei");
        assert_eq!(derive_display_name("肥牛-cubism4"), "肥牛");
        assert_eq!(derive_display_name("haru_greeter_t03"), "haru_greeter_t03");
        assert_eq!(derive_display_name(""), "model");
    }

    // ---- resolve_import_target_dir：计划 acceptance ④ ----

    #[test]
    fn target_is_base_when_absent() {
        let tmp = TempDir::new("target-absent");
        let root = tmp.path().join("models");
        let src = tmp.path().join("downloads").join("lafei_4");
        fs::create_dir_all(&src).expect("创建源目录失败");
        fs::write(src.join("lafei_4.model3.json"), "{}").expect("写入入口文件失败");

        let (dest, name) = resolve_import_target_dir(&root, &src, "lafei").expect("落点决策失败");
        assert_eq!(name, "lafei");
        assert_eq!(dest, root.join("lafei"));
        assert!(!dest.exists(), "不存在的落点不应被创建（由调用方复制时创建）");
    }

    #[test]
    fn target_is_idempotent_when_src_equals_dest() {
        let tmp = TempDir::new("target-same");
        let root = tmp.path().join("models");
        let target = root.join("lafei");
        fs::create_dir_all(&target).expect("创建目标目录失败");
        fs::write(target.join("keep.txt"), "keep").expect("写入哨兵文件失败");

        let (dest, name) =
            resolve_import_target_dir(&root, &target, "lafei").expect("落点决策失败");
        assert_eq!(name, "lafei");
        assert_eq!(dest, target);
        // 幂等复用：既有目录与内容必须原样保留（不得复制、不得删除）
        assert_eq!(
            fs::read_to_string(target.join("keep.txt")).expect("读取哨兵文件失败"),
            "keep"
        );
    }

    #[test]
    fn target_gets_numeric_suffix_when_source_differs() {
        let tmp = TempDir::new("target-conflict");
        let root = tmp.path().join("models");
        let existing = root.join("lafei");
        fs::create_dir_all(&existing).expect("创建既有目录失败");
        fs::write(existing.join("keep.txt"), "keep").expect("写入哨兵文件失败");

        let src = tmp.path().join("elsewhere").join("lafei");
        fs::create_dir_all(&src).expect("创建源目录失败");

        let (dest2, name2) =
            resolve_import_target_dir(&root, &src, "lafei").expect("落点决策失败");
        assert_eq!(name2, "lafei (2)");
        assert_eq!(dest2, root.join("lafei (2)"));

        // 既有目录不得被删除 / 改写
        assert_eq!(
            fs::read_to_string(existing.join("keep.txt")).expect("读取哨兵文件失败"),
            "keep"
        );

        // 再占一个序号 → (3)
        fs::create_dir_all(&dest2).expect("创建 (2) 目录失败");
        let (dest3, name3) =
            resolve_import_target_dir(&root, &src, "lafei").expect("落点决策失败");
        assert_eq!(name3, "lafei (3)");
        assert_eq!(dest3, root.join("lafei (3)"));
    }

    #[test]
    fn target_name_stays_within_length_limit() {
        let tmp = TempDir::new("target-long");
        let root = tmp.path().join("models");
        let long_base: String = "a".repeat(50);
        fs::create_dir_all(root.join(&long_base)).expect("创建超长名目录失败");
        let src = tmp.path().join("another-source");
        fs::create_dir_all(&src).expect("创建源目录失败");

        let (_, name) =
            resolve_import_target_dir(&root, &src, &long_base).expect("落点决策失败");
        assert!(name.ends_with(" (2)"), "应带同名序号后缀，实际: {name}");
        assert!(
            name.chars().count() <= MAX_MODEL_NAME_LEN,
            "目录名超过 {MAX_MODEL_NAME_LEN} 字符: {}",
            name.chars().count()
        );
    }
}