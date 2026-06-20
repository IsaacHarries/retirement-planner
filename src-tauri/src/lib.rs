use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;

// --- file IO for the user-chosen data directory (full paths, no scope limits) ---
#[tauri::command]
fn data_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn read_data(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_data(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![data_exists, read_data, write_data])
        .menu(|handle| {
            let choose =
                MenuItemBuilder::with_id("choose_data_folder", "Choose Data Folder…").build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Retirement Planner")
                .about(None)
                .separator()
                .quit()
                .build()?;
            let file_menu = SubmenuBuilder::new(handle, "File").item(&choose).build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            MenuBuilder::new(handle)
                .items(&[&app_menu, &file_menu, &edit_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "choose_data_folder" {
                let _ = app.emit("menu-choose-data-folder", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Retirement Planner application");
}
