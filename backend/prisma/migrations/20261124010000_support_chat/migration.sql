CREATE TABLE SupportSettings (
  id INT NOT NULL PRIMARY KEY,
  agentId VARCHAR(36) NULL,
  emailEnabled BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (agentId) REFERENCES User(id) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE SupportThread (
  customerId VARCHAR(36) NOT NULL PRIMARY KEY,
  agentId VARCHAR(36) NULL,
  pendingAt DATETIME(3) NULL,
  customerRead INT NOT NULL DEFAULT 0,
  agentRead INT NOT NULL DEFAULT 0,
  updatedAt DATETIME(3) NOT NULL,
  INDEX SupportThread_agentId_updatedAt_idx(agentId,updatedAt),
  FOREIGN KEY (agentId) REFERENCES User(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (customerId) REFERENCES User(id) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE SupportMessage (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customerId VARCHAR(36) NOT NULL,
  senderId VARCHAR(36) NOT NULL,
  fromAgent BOOLEAN NOT NULL,
  requestId VARCHAR(36) NOT NULL,
  text TEXT NOT NULL,
  audio MEDIUMBLOB NULL,
  audioType VARCHAR(24) NULL,
  orderId VARCHAR(36) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX SupportMessage_senderId_requestId_key(senderId,requestId),
  INDEX SupportMessage_customerId_id_idx(customerId,id),
  FOREIGN KEY (customerId) REFERENCES SupportThread(customerId) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (orderId) REFERENCES `Order`(id) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE SupportReminder (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customerId VARCHAR(36) NOT NULL,
  agentId VARCHAR(36) NOT NULL,
  nextAttempt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempts INT NOT NULL DEFAULT 0,
  deliveredAt DATETIME(3) NULL,
  INDEX SupportReminder_deliveredAt_nextAttempt_idx(deliveredAt,nextAttempt)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO SupportSettings (id,emailEnabled) VALUES (1,false);
