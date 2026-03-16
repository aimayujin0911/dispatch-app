from sqlalchemy import Column, Integer, String, Float, Date, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(Integer, primary_key=True, index=True)
    number = Column(String(20), unique=True, nullable=False)
    type = Column(String(50), nullable=False)
    capacity = Column(Float, nullable=False)
    status = Column(String(20), default="空車")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    dispatches = relationship("Dispatch", back_populates="vehicle")


class Driver(Base):
    __tablename__ = "drivers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False)
    phone = Column(String(20), default="")
    license_type = Column(String(30), default="普通")
    status = Column(String(20), default="待機中")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    dispatches = relationship("Dispatch", back_populates="driver")
    daily_reports = relationship("DailyReport", back_populates="driver")


class Shipment(Base):
    __tablename__ = "shipments"

    id = Column(Integer, primary_key=True, index=True)
    client_name = Column(String(100), nullable=False)
    cargo_description = Column(String(200), default="")
    weight = Column(Float, default=0)
    pickup_address = Column(String(200), nullable=False)
    delivery_address = Column(String(200), nullable=False)
    pickup_date = Column(Date, nullable=False)
    delivery_date = Column(Date, nullable=False)
    price = Column(Integer, default=0)
    status = Column(String(20), default="未配車")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    dispatches = relationship("Dispatch", back_populates="shipment")


class Dispatch(Base):
    __tablename__ = "dispatches"

    id = Column(Integer, primary_key=True, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=False)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=False)
    shipment_id = Column(Integer, ForeignKey("shipments.id"), nullable=False)
    date = Column(Date, nullable=False)
    status = Column(String(20), default="予定")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    vehicle = relationship("Vehicle", back_populates="dispatches")
    driver = relationship("Driver", back_populates="dispatches")
    shipment = relationship("Shipment", back_populates="dispatches")


class DailyReport(Base):
    __tablename__ = "daily_reports"

    id = Column(Integer, primary_key=True, index=True)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=False)
    date = Column(Date, nullable=False)
    start_time = Column(String(5), default="")
    end_time = Column(String(5), default="")
    distance_km = Column(Float, default=0)
    fuel_liters = Column(Float, default=0)
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.now)

    driver = relationship("Driver", back_populates="daily_reports")
