/** Path of `test-vectors/envelope-v1.json`. */
export declare const VECTORS_FILE: string;
/** The text of the vectors file, every case checked against `verifyEvent`. */
export declare function buildVectors(): Promise<string>;
