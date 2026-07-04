{
  "targets": [
    {
      "target_name": "newamp_audio",
      "sources": ["binding.cpp"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "conditions": [
        ["OS=='linux'", {
          "libraries": ["-ldl", "-lpthread", "-lm"],
          "cflags_cc": ["-fexceptions"]
        }],
        ["OS=='mac'", {
          "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES" },
          "link_settings": {
            "libraries": ["-framework CoreAudio", "-framework CoreFoundation"]
          }
        }]
      ]
    }
  ]
}
