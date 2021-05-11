import {fileURLToPath} from 'url'
import path from 'path'

export default path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
