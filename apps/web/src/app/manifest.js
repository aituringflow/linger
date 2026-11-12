export default function manifest() {
  return {
    name: "灵儿 Linger",
    short_name: "灵儿",
    description: "你的桌面数字分身",
    start_url: "/linger/",
    scope: "/linger/",
    display: "standalone",
    background_color: "#202020",
    theme_color: "#202020",
    icons: [
      { src: "/linger/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/linger/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
