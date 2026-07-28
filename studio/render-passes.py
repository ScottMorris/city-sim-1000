# Studio prototype — pass renderer entry point.
#
# Renders ONE building scene FOUR ways and makes zero style decisions:
#   shaded.png — plain diffuse materials under the fixed studio sun
#   albedo.png — flat emission of each role's working colour
#   id.png     — flat emission of a unique colour per role
#   height.png — world Z as greyscale (surface-pattern contours)
#
# All styling happens in the Node stylizer (stylize.mjs) from these passes.
# One render -> many looks. See AUTHORING.md for the full contract.
#
# Run headless (scene name after `--`, default `house`):
#   docker run --rm -v "$PWD/studio":/studio nytimes/blender:3.3.1-cpu-ubuntu18.04 \
#     blender -b -P /studio/render-passes.py -- shop
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import importlib
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import studiolib

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
scene_name = argv[0] if argv else 'house'
scene_module = importlib.import_module(f'scenes.{scene_name}')

# Multi-variant scenes (e.g. rail): remaining args select variants ('all' for
# every one); each renders as <scene>-<variant> with real rotated geometry.
if hasattr(scene_module, 'VARIANTS') and len(argv) > 1:
    wanted = list(scene_module.VARIANTS) if argv[1] == 'all' else argv[1:]
    for variant in wanted:
        scene_module.VARIANT = variant
        studiolib.run(f'{scene_name}-{variant}', scene_module)
else:
    studiolib.run(scene_name, scene_module)
