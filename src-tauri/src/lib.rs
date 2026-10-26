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

/// 读取外部地址列表（文件缺失 / 损坏 → 空列表，绝不抛错）。
fn load_external_roots(app: &AppHandle) -> Vec<ExternalDir> {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = parsed
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

/// 写回外部地址列表（确保目录存在；失败返回 Err，由命令转成结构化错误）。
fn save_external_roots(app: &AppHandle, roots: &[ExternalDir]) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let list: Vec<serde_json::Value> = roots
        .iter()
        .map(|r| serde_json::json!({ "id": r.id, "path": r.path }))
        .collect();
    let doc = serde_json::json!({ "externalModels": list });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入配置失败: {e}"))
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
                name: dir_name,
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

/// 读取模型清单：扫描「程序 models/（导入落点）」＋「全部外部模型根」。
/// 内置 models/（随前端分发）清单由前端读 models.json 合并，不在此处扫描。
/// 前端 `invoke('get_model_list')`，返回 [{ id, name, url, type, source }]。
#[tauri::command]
fn get_model_list(app: AppHandle) -> Vec<ModelEntry> {
    let mut out: Vec<ModelEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1) 程序目录（exe 同级 models/）：导入落点；source='imported'（前端据此显示「删除」）
    if let Ok(dir) = exe_models_dir() {
        for m in scan_models_in_root(&dir, "imported") {
            if seen.insert(m.url.clone()) {
                out.push(m);
            }
        }
    }

    // 2) 已引用的外部模型文件夹（多根）：source='external'
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
// 程序目录模型（exe 同级 models/）：导入 / 删除
// ---------------------------------------------------------------------------
//
// 单 exe「绿色版」约定：程序目录 = **可执行文件同级**，模型库为其下的 `models/`。
//   * 导入：把选中的模型目录递归复制到 `<exe_dir>/models/<模型名>/`（同名覆盖、幂等）；
//   * 列表：`get_model_list` 扫描该目录（source='imported'）→ 导入后立即出现在列表；
//   * 删除：删除 `<exe_dir>/models/<模型名>/`（或外部根内的模型目录），带安全边界校验。

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

/// 导入模型：弹原生选择器 → 定位模型目录 → 递归复制到
/// `<exe_dir>/models/<模型名>/`（同名覆盖、幂等）→ 返回模型条目。
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

    // 目标：<exe_dir>/models/<模型名>；同名覆盖（先删旧目录再复制，保证幂等）
    let dir_name = src_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let folder = sanitize_model_name(&dir_name);
    let models_root = exe_models_dir()?;
    fs::create_dir_all(&models_root).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let dest = models_root.join(&folder);

    // 防御：源目录即目标目录（重复导入自身）→ 直接返回现有条目，不做破坏性删除
    if src_dir == dest {
        let abs = dest.join(&entry_file);
        return Ok(Some(ModelEntry {
            id: folder.clone(),
            name: dir_name,
            url: abs.to_string_lossy().to_string(),
            model_type,
            source: "imported".to_string(),
        }));
    }

    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("清理同名模型目录失败: {e}"))?;
    }
    copy_dir_all(&src_dir, &dest).map_err(|e| format!("复制模型失败: {e}"))?;

    let abs_entry = dest.join(&entry_file);
    Ok(Some(ModelEntry {
        id: folder.clone(),
        name: dir_name,
        url: abs_entry.to_string_lossy().to_string(),
        model_type,
        source: "imported".to_string(),
    }))
}

/// 删除模型：删除 `<exe_dir>/models/<模型名>/`（或外部根内的模型目录）。
///
/// 入参 `idOrPath` 可为模型 **id（目录名）** 或模型 **入口文件的绝对路径**（前端优先传 url）。
/// 安全：仅允许删除「程序 models/ 之下」或「已引用外部根之下」的目录；越界返回错误。
/// 前端 `invoke('delete_model', { idOrPath })`；目标已不存在时返回 Ok(false)（幂等）。
#[tauri::command]
fn delete_model(app: AppHandle, id_or_path: String) -> Result<bool, String> {
    let key = id_or_path.trim();
    if key.is_empty() {
        return Err("缺少模型标识".to_string());
    }

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
        exe_models_dir()?.join(key)
    };

    if !target.exists() {
        return Ok(false); // 已不存在：视为已完成（幂等）
    }

    // 2) 安全校验：仅可删除程序 models/ 或任一已引用外部根之下的目录
    let exe_models = exe_models_dir()?;
    let roots = load_external_roots(&app);
    let allowed = is_within(&target, &exe_models)
        || roots
            .iter()
            .any(|r| !r.path.is_empty() && is_within(&target, Path::new(&r.path)));
    if !allowed {
        return Err("不允许删除该目录（仅可删除程序 models/ 或已引用外部文件夹内的模型）".to_string());
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
            // 导入 / 删除程序目录模型（exe 同级 models/）
            import_model,
            delete_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running DesktopPet (Tauri) application");
}