// schema/*.schema.json の写し。生成物：node test/core/helpers/gen-schemas.js で作り直す（手で書き換えない）。
// core は fs を使わないので、スキーマを JS のオブジェクトとして持つ。schema/ が正で、test/core/validate.test.js が一致を検査する。
export const SCHEMAS = {
  "boundaries": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/boundaries",
    "description": "Slide boundaries of one continuous recording (dev/PLAN2.md, CONTRACTS.md 7.8). Intervals [startSample, endSample) are contiguous; the contiguity, the script and the audio are checked by core checkBoundaries.",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "format",
      "version",
      "sampleRate",
      "audio",
      "script",
      "slides"
    ],
    "properties": {
      "format": {
        "const": "lap-narrator/boundaries"
      },
      "version": {
        "const": 1
      },
      "sampleRate": {
        "type": "integer",
        "minimum": 8000,
        "maximum": 9007199254740991
      },
      "audio": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "sha256",
          "samples"
        ],
        "properties": {
          "file": {
            "type": "string"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "samples": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        }
      },
      "transcript": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "sha256"
        ],
        "properties": {
          "file": {
            "type": "string"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "model": {
            "type": "string"
          }
        }
      },
      "script": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "scriptHash"
        ],
        "properties": {
          "scriptHash": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          }
        }
      },
      "slides": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": [
            "slideId",
            "order",
            "startSample",
            "endSample",
            "status"
          ],
          "properties": {
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "order": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "startSample": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "endSample": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "method": {
              "type": "string",
              "enum": [
                "asr-align",
                "manual",
                "interpolated"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "auto",
                "confirmed",
                "needs-decision"
              ]
            },
            "candidates": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "sample"
                ],
                "properties": {
                  "sample": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "score": {
                    "type": "number"
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "cli-result": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/cli-result",
    "type": "object",
    "required": [
      "ok",
      "command",
      "warnings",
      "errors"
    ],
    "additionalProperties": false,
    "properties": {
      "ok": {
        "type": "boolean"
      },
      "command": {
        "type": "string"
      },
      "result": {
        "type": "object",
        "additionalProperties": true
      },
      "warnings": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "code",
            "message"
          ],
          "additionalProperties": true,
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          }
        }
      },
      "errors": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "code",
            "message"
          ],
          "additionalProperties": true,
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "edits": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/edits",
    "type": "object",
    "required": [
      "format",
      "version",
      "sessionId",
      "editVersion"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/edits"
      },
      "version": {
        "const": 1
      },
      "sessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "editVersion": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "joins": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "takeId",
            "index"
          ],
          "additionalProperties": false,
          "properties": {
            "takeId": {
              "type": "string",
              "pattern": "^t[0-9]{4}$"
            },
            "index": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "trimPrevEnd": {
              "type": "integer",
              "maximum": 9007199254740991
            },
            "shiftNextStart": {
              "type": "integer",
              "maximum": 9007199254740991
            }
          }
        }
      },
      "fadeSamples": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "gainDb": {
        "type": "object",
        "additionalProperties": true
      },
      "selections": {
        "type": "object",
        "additionalProperties": true
      },
      "limiter": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ceilingDb": {
            "type": "number",
            "maximum": 0
          }
        }
      }
    }
  },
  "events": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/event",
    "description": "events.jsonl の 1 行。type ごとの必須項目は core/reduce の検査で確かめる（CONTRACTS.md 1.4）。",
    "type": "object",
    "required": [
      "seq",
      "eventId",
      "type",
      "wall",
      "mono"
    ],
    "additionalProperties": true,
    "properties": {
      "seq": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "eventId": {
        "type": "string",
        "pattern": "^e[0-9]+$"
      },
      "type": {
        "type": "string",
        "enum": [
          "session-start",
          "test-rec",
          "rec-start",
          "file-rotate",
          "durable",
          "ok",
          "retake",
          "next-slide",
          "goto-slide",
          "pause",
          "resume",
          "recovered",
          "mark",
          "undo",
          "redo",
          "export"
        ]
      },
      "wall": {
        "type": "string"
      },
      "mono": {
        "type": "number",
        "minimum": 0
      },
      "at": {
        "type": "object",
        "required": [
          "raw",
          "sample",
          "pos"
        ],
        "additionalProperties": false,
        "properties": {
          "raw": {
            "type": "string",
            "pattern": "^rec-[0-9]{6}$"
          },
          "sample": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "pos": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      },
      "slideId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{1,64}$"
      },
      "takeId": {
        "type": "string",
        "pattern": "^t[0-9]{4}$"
      },
      "checkpointId": {
        "type": "string",
        "pattern": "^c[0-9]{4}$"
      },
      "target": {
        "type": "string",
        "pattern": "^e[0-9]+$"
      },
      "toCheckpoint": {
        "oneOf": [
          {
            "type": "string",
            "pattern": "^c[0-9]{4}$"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "index": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/index",
    "type": "object",
    "required": [
      "format",
      "version",
      "exportId",
      "kind",
      "projectId",
      "sessionId",
      "volumes",
      "zips"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/index"
      },
      "version": {
        "const": 1
      },
      "exportId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "kind": {
        "type": "string",
        "enum": [
          "full",
          "final"
        ]
      },
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "sessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "volumes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "zips": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": [
            "volume",
            "file",
            "bytes",
            "sha256"
          ],
          "additionalProperties": false,
          "properties": {
            "volume": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "file": {
              "type": "string"
            },
            "bytes": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          }
        }
      }
    }
  },
  "manifest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/manifest",
    "type": "object",
    "required": [
      "format",
      "version",
      "kind",
      "projectId",
      "scriptHash",
      "sessionId",
      "exportId",
      "volume",
      "volumes",
      "appVersion",
      "files",
      "createdAt"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/manifest"
      },
      "version": {
        "const": 1
      },
      "kind": {
        "type": "string",
        "enum": [
          "full",
          "final"
        ]
      },
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "scriptHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "sessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "exportId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "volume": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "volumes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "appVersion": {
        "type": "string"
      },
      "speaker": {
        "type": "string"
      },
      "device": {
        "type": "object",
        "additionalProperties": true
      },
      "mic": {
        "type": "object",
        "additionalProperties": true
      },
      "rawFiles": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "file",
            "sampleRate",
            "samples",
            "sha256"
          ],
          "additionalProperties": false,
          "properties": {
            "file": {
              "type": "string",
              "pattern": "^(?![/\\\\])(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"
            },
            "sampleRate": {
              "type": "integer",
              "minimum": 8000,
              "maximum": 9007199254740991
            },
            "samples": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "durableSamples": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          }
        }
      },
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "path",
            "bytes",
            "sha256"
          ],
          "additionalProperties": false,
          "properties": {
            "path": {
              "type": "string",
              "pattern": "^(?![/\\\\])(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"
            },
            "bytes": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          }
        }
      },
      "renderSpec": {
        "type": "object",
        "additionalProperties": true
      },
      "finals": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "slideId",
            "takeId",
            "parts",
            "samples",
            "sampleRate"
          ],
          "additionalProperties": true,
          "properties": {
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "takeId": {
              "type": "string",
              "pattern": "^t[0-9]{4}$"
            },
            "samples": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "sampleRate": {
              "type": "integer",
              "minimum": 8000,
              "maximum": 9007199254740991
            },
            "parts": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": [
                  "file",
                  "samples",
                  "sha256"
                ],
                "additionalProperties": false,
                "properties": {
                  "file": {
                    "type": "string",
                    "pattern": "^(?![/\\\\])(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$"
                  },
                  "samples": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{64}$"
                  }
                }
              }
            },
            "applied": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "createdAt": {
        "type": "string"
      },
      "editVersion": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "recording": {
        "type": "string",
        "enum": [
          "continuous",
          "per-slide"
        ]
      }
    }
  },
  "script": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/script",
    "type": "object",
    "required": [
      "format",
      "version",
      "projectId",
      "title",
      "scriptHash",
      "slides"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/script"
      },
      "version": {
        "const": 1
      },
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "title": {
        "type": "string",
        "maxLength": 300
      },
      "scriptHash": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$"
      },
      "slides": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": [
            "slideId",
            "order",
            "text",
            "recordable",
            "textHash"
          ],
          "additionalProperties": false,
          "properties": {
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "order": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "title": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "recordable": {
              "type": "boolean"
            },
            "speaker": {
              "type": "string"
            },
            "targetSec": {
              "type": "number",
              "minimum": 0
            },
            "image": {
              "type": "string"
            },
            "imageSha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "textHash": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          }
        }
      }
    }
  },
  "segments": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/segments",
    "type": "object",
    "required": [
      "format",
      "version",
      "sessionId",
      "segments",
      "takes",
      "defaultTakes",
      "issues"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/segments"
      },
      "version": {
        "const": 1
      },
      "sessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{6,64}$"
      },
      "segments": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "segmentId",
            "takeId",
            "slideId",
            "raw",
            "start",
            "end",
            "status",
            "order"
          ],
          "additionalProperties": false,
          "properties": {
            "segmentId": {
              "type": "string",
              "pattern": "^g[0-9]{5,}$"
            },
            "takeId": {
              "type": "string",
              "pattern": "^t[0-9]{4}$"
            },
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "raw": {
              "type": "string",
              "pattern": "^rec-[0-9]{6}$"
            },
            "start": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "end": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "startSec": {
              "type": "number",
              "minimum": 0
            },
            "endSec": {
              "type": "number",
              "minimum": 0
            },
            "status": {
              "type": "string",
              "enum": [
                "kept",
                "discarded",
                "uncommitted"
              ]
            },
            "reason": {
              "type": "string"
            },
            "order": {
              "oneOf": [
                {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            }
          }
        }
      },
      "takes": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "takeId",
            "slideId",
            "status",
            "startSeq",
            "segments",
            "samples",
            "candidate"
          ],
          "additionalProperties": false,
          "properties": {
            "takeId": {
              "type": "string",
              "pattern": "^t[0-9]{4}$"
            },
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "status": {
              "type": "string",
              "enum": [
                "open",
                "closed"
              ]
            },
            "startSeq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "endSeq": {
              "oneOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "segments": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "samples": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "candidate": {
              "type": "boolean"
            }
          }
        }
      },
      "defaultTakes": {
        "type": "object",
        "additionalProperties": true
      },
      "recoverable": {
        "oneOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "required": [
              "pos",
              "raw",
              "sample"
            ],
            "additionalProperties": true,
            "properties": {
              "pos": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "raw": {
                "type": "string",
                "pattern": "^rec-[0-9]{6}$"
              },
              "sample": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "lastCheckpointId": {
                "oneOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        ]
      },
      "marks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "issues": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "code",
            "message"
          ],
          "additionalProperties": true,
          "properties": {
            "code": {
              "type": "string"
            },
            "seq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "message": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "timeline": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/timeline",
    "type": "object",
    "required": [
      "format",
      "version",
      "sampleRate",
      "fps",
      "prePadSamples",
      "postPadSamples",
      "slides",
      "totalSamples"
    ],
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "lap-narrator/timeline"
      },
      "version": {
        "const": 1
      },
      "sampleRate": {
        "type": "integer",
        "minimum": 8000,
        "maximum": 9007199254740991
      },
      "fps": {
        "type": "integer",
        "minimum": 1,
        "maximum": 120
      },
      "prePadSamples": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "postPadSamples": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "totalSamples": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "slides": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "slideId",
            "order",
            "image",
            "audio",
            "audioSamples",
            "showStart",
            "audioStart",
            "audioEnd",
            "showEnd"
          ],
          "additionalProperties": false,
          "properties": {
            "slideId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,64}$"
            },
            "order": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "image": {
              "type": "string"
            },
            "audio": {
              "oneOf": [
                {
                  "type": "string"
                },
                {
                  "type": "array",
                  "minItems": 1,
                  "items": {
                    "type": "string"
                  }
                }
              ]
            },
            "audioSamples": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "showStart": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "audioStart": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "audioEnd": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "showEnd": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          }
        }
      }
    }
  },
  "transcript": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "lap-narrator/transcript",
    "description": "Word-level transcript of one audio file (dev/PLAN2.md, CONTRACTS.md 7.8). Times are seconds. Extra keys (engine, params, timing, ...) are allowed.",
    "type": "object",
    "required": [
      "format",
      "version",
      "audio",
      "model",
      "words",
      "segments"
    ],
    "properties": {
      "format": {
        "const": "lap-narrator/transcript"
      },
      "version": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "audio": {
        "type": "object",
        "required": [
          "sha256",
          "samples"
        ],
        "properties": {
          "file": {
            "type": "string"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          },
          "sampleRate": {
            "type": "integer",
            "minimum": 8000,
            "maximum": 9007199254740991
          },
          "samples": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      },
      "model": {
        "type": "string"
      },
      "language": {
        "type": "string"
      },
      "words": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "w",
            "start",
            "end"
          ],
          "properties": {
            "w": {
              "type": "string"
            },
            "start": {
              "type": "number",
              "minimum": 0
            },
            "end": {
              "type": "number",
              "minimum": 0
            },
            "p": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        }
      },
      "segments": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "start",
            "end",
            "text"
          ],
          "properties": {
            "start": {
              "type": "number",
              "minimum": 0
            },
            "end": {
              "type": "number",
              "minimum": 0
            },
            "text": {
              "type": "string"
            }
          }
        }
      },
      "timing": {
        "type": "object"
      },
      "engine": {
        "type": "object"
      },
      "params": {
        "type": "object"
      }
    }
  },
};
