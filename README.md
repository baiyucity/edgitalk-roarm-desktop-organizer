# Edgi-Talk RoArm Desktop Organizer

基于 Edgi-Talk 双核开发板与 RoArm-M2-S1 机械臂的桌面物品识别与自动整理系统。

本项目通过 UVC 摄像头采集桌面图像，在 Edgi-Talk M55 侧完成目标检测、图像处理和坐标提取，再通过 M55-M33 双核通信将目标坐标发送至 M33。M33 侧负责串口通信、坐标转换和机械臂控制，并通过 UART 向 RoArm-M2-S1 发送 JSON 指令，实现桌面物品的自动抓取、移动和放置。

## Project Overview

This project is a vision-based desktop organizing robotic arm system using the Edgi-Talk dual-core development board and the RoArm-M2-S1 robotic arm.

The system captures images from a USB UVC camera, detects target objects on the desktop, extracts their image coordinates, and sends the coordinates from the M55 core to the M33 core. The M33 core then communicates with the RoArm-M2-S1 robotic arm through UART and controls the robotic arm to pick and place desktop objects.

## Hardware

| Module                      | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| Edgi-Talk Development Board | Main control board with M55 and M33 cores            |
| RoArm-M2-S1                 | Robotic arm for object grasping and placement        |
| USB UVC Camera              | Captures desktop images                              |
| LCD Screen                  | Displays camera stream and recognition results       |
| 5V Power Supply             | Provides power for the control board and robotic arm |
| UART Connection             | Communication link between Edgi-Talk and RoArm       |

## System Architecture

```text
USB UVC Camera
      ↓
Edgi-Talk M55 Core
- Camera stream processing
- Object detection
- Bounding box and center coordinate extraction
      ↓
M55-M33 IPC Communication
      ↓
Edgi-Talk M33 Core
- Coordinate receiving
- Coordinate mapping
- UART command generation
      ↓
RoArm-M2-S1 Robotic Arm
- Approach target
- Grasp object
- Lift object
- Move to target area
- Release object
```

## Directory Structure

```text
.
├─ APP_function_files/
│  ├─ App.jsx
│  └─ legacy_app_src_App.jsx
│
├─ M33-IPS_applications/
│  ├─ roarm_uart.c
│  ├─ roarm_uart.h
│  ├─ soft_uart_tx.c
│  ├─ soft_uart_tx.h
│  └─ vision_ipc_rx.c
│
├─ M55-applications/
│  ├─ main.c
│  ├─ robot_arm_wifi_app_bridge.c
│  ├─ SConscript
│  ├─ uvc_ai_app.c
│  ├─ uvc_ai_app.h
│  ├─ uvc_ai_ethosu_rtos.c
│  ├─ vision_ipc_tx.c
│  └─ vision_ipc_tx.h
│
└─ M55-libraries/
   ├─ Common/
   │  ├─ board/
   │  └─ deepcraft_ai/
   ├─ M33_Config/
   └─ M55_Config/
```

## Main Components

### M55 Application

The M55 side is responsible for camera image acquisition, image processing, object detection, and coordinate transmission.

Main files:

| File                          | Function                                                         |
| ----------------------------- | ---------------------------------------------------------------- |
| `main.c`                      | M55 application entry                                            |
| `uvc_ai_app.c`                | UVC camera and AI vision application logic                       |
| `uvc_ai_app.h`                | Header file for the vision application                           |
| `vision_ipc_tx.c`             | Sends visual detection results from M55 to M33                   |
| `robot_arm_wifi_app_bridge.c` | Bridge logic for robotic arm control and app-related interaction |
| `uvc_ai_ethosu_rtos.c`        | AI-related runtime support                                       |

### M33 Application

The M33 side is responsible for receiving coordinates from M55 and sending control commands to the robotic arm.

Main files:

| File              | Function                                      |
| ----------------- | --------------------------------------------- |
| `vision_ipc_rx.c` | Receives target coordinates from the M55 core |
| `roarm_uart.c`    | UART communication and RoArm command control  |
| `roarm_uart.h`    | RoArm UART control interface                  |
| `soft_uart_tx.c`  | Software UART transmit implementation         |
| `soft_uart_tx.h`  | Software UART transmit interface              |

### Vision Library

The vision processing and AI-related files are located in:

```text
M55-libraries/Common/deepcraft_ai/
```

This part includes the object detection logic, model interface, middleware support, and related third-party machine learning libraries.

### USB Camera and Display Support

USB camera and display-related files are located in:

```text
M55-libraries/Common/board/ports/usb/
M55-libraries/Common/board/ports/display_panels/
```

These files support UVC camera input, JPEG decoding, video stream display, and LCD output.

## Current Features

| Feature                                     | Status         |
| ------------------------------------------- | -------------- |
| USB UVC camera stream input                 | Implemented    |
| LCD video display                           | Implemented    |
| Target object detection                     | Implemented    |
| Bounding box drawing                        | Implemented    |
| Target center coordinate extraction         | Implemented    |
| M55 to M33 IPC communication                | Implemented    |
| M33 to RoArm UART communication             | Implemented    |
| JSON command control for RoArm              | Implemented    |
| Robotic arm pick-and-place action           | Implemented    |
| Multi-object recognition                    | In progress    |
| Precise camera-arm coordinate calibration   | To be improved |
| Stable grasping for different object shapes | To be improved |

## Basic Workflow

```text
1. Start the UVC camera.
2. The M55 core processes the camera image.
3. The target object is detected in the image.
4. The center coordinate of the detected object is calculated.
5. The M55 core sends the coordinate to the M33 core through IPC.
6. The M33 core converts the image coordinate into a robotic arm control target.
7. The M33 core sends JSON commands to RoArm-M2-S1 through UART.
8. RoArm-M2-S1 executes the grasping and placing action.
```

## Communication Design

### M55 to M33

The M55 core sends visual recognition results to the M33 core through inter-core communication. The transmitted information mainly includes:

* Target detection status
* Target center X coordinate
* Target center Y coordinate
* Optional bounding box information
* Optional object class information

### M33 to RoArm

The M33 core controls RoArm-M2-S1 through UART. The robotic arm receives JSON-style control commands and executes corresponding movement or gripping actions.

Example command format:

```json
{"T":1051}
```

The actual command set depends on the RoArm-M2-S1 firmware and the current robotic arm control logic.

## Development Environment

| Item             | Environment                         |
| ---------------- | ----------------------------------- |
| Main Board       | Edgi-Talk / PSOC_E84                |
| Robotic Arm      | RoArm-M2-S1                         |
| Operating System | RT-Thread                           |
| Main Language    | C / C++                             |
| App Interface    | JSX                                 |
| Camera           | USB UVC Camera                      |
| Communication    | IPC + UART                          |
| Build System     | SCons / RT-Thread project structure |

## How to Build

The project is based on the Edgi-Talk vision example and RT-Thread project structure.

General steps:

```text
1. Prepare the official Edgi-Talk development environment.
2. Import the original Edgi-Talk vision example project.
3. Replace or merge the files in M55-applications into the M55 project.
4. Replace or merge the files in M33-IPS_applications into the M33 project.
5. Make sure the required files in M55-libraries are included in the project.
6. Build the M55 firmware.
7. Build the M33 firmware.
8. Flash both firmware images to the Edgi-Talk board.
9. Connect the UVC camera, LCD screen, and RoArm-M2-S1 robotic arm.
10. Start the vision and robotic arm control program.
```

## Hardware Connection

The basic hardware connection is:

| From              | To                          | Description                                |
| ----------------- | --------------------------- | ------------------------------------------ |
| UVC Camera        | Edgi-Talk USB Host          | Camera image input                         |
| Edgi-Talk UART TX | RoArm UART RX               | Send control commands                      |
| Edgi-Talk GND     | RoArm GND                   | Common ground                              |
| Power Supply      | Edgi-Talk / RoArm           | 5V power input                             |
| LCD               | Edgi-Talk display interface | Display camera stream and detection result |

> Note: The exact UART pin assignment depends on the current Edgi-Talk board configuration and firmware version.

## Debug Commands

Some useful debug commands may include:

| Command     | Function                                                    |
| ----------- | ----------------------------------------------------------- |
| `testarm`   | Send a test command from M55 to M33, then from M33 to RoArm |
| `testtx`    | Test UART transmission                                      |
| `lcdtest`   | Test LCD display                                            |
| `uvc_start` | Start UVC camera stream                                     |
| `uvc_stop`  | Stop UVC camera stream                                      |

The exact command names should be checked against the current firmware implementation.

## Known Issues

| Issue                                                                      | Status              |
| -------------------------------------------------------------------------- | ------------------- |
| The camera-to-arm coordinate mapping still needs more accurate calibration | To be improved      |
| Dark background or poor lighting may affect visual detection               | Partially optimized |
| Different object shapes require different gripping strategies              | To be improved      |
| Long-term continuous operation still needs more stability testing          | To be tested        |
| Some files are modified from official examples and need clearer separation | To be cleaned       |

## Future Work

* Add a clearer camera-to-arm calibration procedure.
* Improve object classification for pens, erasers, cosmetic sticks, bottle caps, and boxes.
* Optimize grasping actions for different object shapes.
* Add a more stable object queue and command delay mechanism.
* Improve the mechanical gripper design.
* Add detailed wiring diagrams and software flowcharts.
* Add demo images and videos.
* Add complete build and flashing instructions.

## License

This project is licensed under the MIT License.

Some third-party libraries and official example components may be subject to their own licenses. Please check the corresponding files and original sources before redistribution or commercial use.
