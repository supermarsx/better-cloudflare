# Tauri Icon Placeholder

This directory should contain application icons in various sizes.

To generate proper icons, use the Tauri icon generator:

```bash
# Install the icon generator
npm install -g @tauri-apps/cli

# Generate icons from a source image (1024x1024 PNG recommended)
npm run tauri icon path/to/your/icon.png
```

Required icon files:
- `32x32.png` - Small icon
- `128x128.png` - Medium icon  
- `128x128@2x.png` - Retina display
- `icon.icns` - macOS icon bundle
- `icon.ico` - Windows icon

For now, you can use a placeholder until you create proper branding.
