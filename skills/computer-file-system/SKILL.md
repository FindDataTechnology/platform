---
name: computer-file-system
description: File system operations - list directories, read/write files, create folders
---

# Computer File System Skill

Use this skill to perform file system operations on the local machine.

## Usage

Invoke with: `/skill:computer-file-system <operation> <path> [content]`

### Operations

1. **List directory contents**
   `/skill:computer-file-system list /path/to/directory`

2. **Read file**
   `/skill:computer-file-system read /path/to/file`

3. **Write file** (creates or overwrites)
   `/skill:computer-file-system write /path/to/file "content here"`

4. **Create directory**
   `/skill:computer-file-system mkdir /path/to/directory`

5. **Delete file or directory**
   `/skill:computer-file-system delete /path/to/item`

## Notes

- Paths can be absolute or relative to the server's working directory
- File operations respect the server's process permissions
- Use with caution - this modifies actual files on disk
