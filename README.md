# Media Stream Inspector

**The ultimate developer tool for monitoring, inspecting, and capturing real-time Media Streams on specialized platforms.**
(MediaStreamトラック、暗号化HLS配信、WebRTC接続をリアルタイムでデバッグ・調査するためのプロフェッショナル向け拡張機能)

## 📌 Features

- **Advanced Media Detection:** Detects HLS (.m3u8), MP4, and WebRTC streams that other extensions miss.
- **Subscription Platform Support:** Optimized for specialized fan platforms, subscription-based streaming sites, and artist support services.
- **Encrypted HLS Handling:** Inspects AES-128 key URLs and initialization segments in real-time.
- **Real-time Tracker:** Monitor track states (video/audio), constraints, and stream transitions instantly.
- **WebRTC Inspector:** Deep dive into peer connection tracks and media flow.

## 🚀 Why Use This?

Unlike generic downloaders, **Media Stream Inspector** is designed for the modern web. It specializes in detecting media on sites that use complex delivery systems, making it the perfect tool for developers and power users working with:
- Subscription-based fan communities
- Private video sharing platforms
- Live streaming services with protected content

## 🛠️ Installation (Developer Mode)

1.  Download or clone this repository.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **"Developer mode"** in the top right corner.
4.  Click **"Load unpacked"** and select the folder containing this extension.

## 📖 How to Use

1.  Navigate to the page with the media you want to inspect.
2.  Click the extension icon.
3.  The popup will list all detected streams. You can see Track IDs, Labels, and Resolution Settings.
4.  For HLS content, you can inspect the manifest and encryption details directly.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
