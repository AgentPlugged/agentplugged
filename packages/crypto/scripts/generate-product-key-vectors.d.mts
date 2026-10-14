/** Path of `test-vectors/product-key-v1.json`. */
export declare const PRODUCT_KEY_VECTORS_FILE: string;
/** The text of the product key vectors file, every case decrypted again. */
export declare function buildProductKeyVectors(): Promise<string>;
